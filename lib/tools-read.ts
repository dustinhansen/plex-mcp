/** The tools that read a library and its items, and the filter and fetch
 *  helpers the other tool modules build on. */
import { z } from "zod";
import { listParams, SORT_KEYS, KIND_TYPE, hasDefaultKind, sectionKind, sinceValue } from "./filters.js";
import { itemDict, extraDict, iso, isWatched, sectionDict, libraryType, hasPersonalMediaAgent, playUser, project } from "./format.js";
import { isNotFound } from "./upstream.js";
import { defineTool, PLEX_ID, READ_ONLY } from "../types/tool-registration.js";
import type { PlexClient, PlexMediaContainer, PlexMetadata, Query } from "../types/boundaries.js";

/** library_changes reads a section's /all listing, which never holds
 *  collections, so its kinds stop short of "collection". */
const CHANGE_KINDS = ["movie", "show", "season", "episode", "artist", "album", "track"] as const;
export const KINDS = [...CHANGE_KINDS, "collection"] as const;

/** A name the tool resolves against the library. An empty one would match the
 *  first tag or person Plex lists, so it is refused rather than guessed at. */
const nonBlank = (parameter: string) => z.string().trim().min(1, `${parameter} cannot be blank`);

/** The library filter vocabulary shared by list_media and random_pick. */
export const FILTER_SCHEMA = {
  library: z.string().default("Movies"),
  kind: z.enum(KINDS).optional(),
  watched: z.enum(["all", "watched", "unwatched"]).default("all"),
  rated: z.enum(["all", "rated", "unrated"]).default("all"),
  genre: nonBlank("genre").optional(),
  year: z.number().int().optional(),
  decade: z.string().optional().describe("e.g. '1970s'"),
  contentRating: z.string().optional().describe("e.g. 'PG-13'"),
  collection: nonBlank("collection").optional().describe("filter to members of a collection"),
  country: nonBlank("country").optional(),
  studio: nonBlank("studio").optional(),
  maxDurationMin: z.number().int().optional(),
  addedSince: z.string().optional().describe("ISO date or relative like '-30d'"),
  lastViewedBefore: z.string().optional()
    .describe("last viewed before this ISO date or relative like '-3y'. Never-watched items match too unless watched='watched'"),
  lastViewedAfter: z.string().optional().describe("last viewed after this ISO date or relative like '-30d'"),
};

/** Resolve the name-based filters (genre etc.) to the values Plex filters on:
 *  a tag id, or for studio the studio's own name. Studio is a plain field, not
 *  a tag. Plex lists each studio's key as its name URL-encoded twice, and the
 *  filter matches only the name itself. */
export async function resolveFilterTags(client: PlexClient, sectionKey: string, args: Record<string, unknown>): Promise<Record<string, string>> {
  const tagIds: Record<string, string> = {};
  for (const field of ["genre", "collection", "country", "studio"]) {
    if (typeof args[field] !== "string") continue;
    const hit = await client.resolveSectionTag(sectionKey, field, args[field]);
    tagIds[field] = field === "studio" ? hit.name : hit.id;
  }
  return tagIds;
}

const pageSchema = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
  detail: z.boolean().default(false),
  fields: z.array(z.string()).optional().describe("project each record to these keys (ratingKey always kept). Use to keep large listings small"),
};
export const HOME_USER_SCHEMA = z.string().optional().describe("see the library as this Plex Home user (name or id)");
/** The most records a detail=true page holds, since each one costs a full
 *  metadata fetch. Tool descriptions read the number from here. */
export const DETAIL_CAP = 25;
export const effLimit = (limit: number, detail: boolean) => (detail ? Math.min(limit, DETAIL_CAP) : limit);
/** How a tool whose detail=true caps its page states the cap. */
export const DETAIL_CAP_CLAUSE = `detail=true caps limit at ${DETAIL_CAP}`;
/** The fields detail=true adds to a record, named as examples because itemDict adds more. */
export const DETAIL_FIELDS_PHRASE = "fields such as directors, actors, collections and summaries";
/** How a tool whose detail=true caps its page and adds fields describes both. */
const DETAIL_FIELDS_CLAUSE = `${DETAIL_CAP_CLAUSE} and adds ${DETAIL_FIELDS_PHRASE}.`;

const page = (container: PlexMediaContainer, offset: number, detail: boolean, fields?: string[]) => {
  const items = (container.Metadata ?? []).map((item) => project(itemDict(item, detail), fields));
  const total = container.totalSize ?? container.size ?? items.length;
  const next = offset + items.length;
  return { total, offset, returned: items.length, nextOffset: next < total ? next : null, items };
};

/** The full metadata of every item Plex has among `keys`, in one request.
 *  Plex omits keys it no longer has, and answers 404 when it has none of them.
 *  No keys sends nothing. */
export async function fetchItems(client: PlexClient, keys: readonly string[]): Promise<PlexMetadata[]> {
  if (!keys.length) return [];
  return client.plex(`/library/metadata/${keys.join(",")}`).then((container) => container.Metadata ?? [], (error: unknown) => {
    if (isNotFound(error)) return [];
    throw error;
  });
}

/** A listing names only some of its items' collections, so detail records
 *  take them from the items' full metadata. */
export async function withCollections(client: PlexClient, container: PlexMediaContainer): Promise<PlexMediaContainer> {
  const items = container.Metadata ?? [];
  // Plex can list an item without its ratingKey, and that item has no full metadata to fetch.
  const keys = items.flatMap((item) => (item.ratingKey === undefined ? [] : [item.ratingKey]));
  if (!keys.length) return container;
  const full = await fetchItems(client, keys);
  const byKey = new Map(full.map((item) => [item.ratingKey, item.Collection]));
  return { ...container, Metadata: items.map((item) => ({ ...item, Collection: byKey.get(item.ratingKey) ?? item.Collection })) };
}

const EXTERNAL_ID = /^(?<scheme>imdb|tmdb|tvdb):(?:\/\/)?(?<id>[^\s/]+)$/i;
/** The legacy agents keep the id in the item's own guid instead. */
const LEGACY_AGENT_GUID = /^com\.plexapp\.agents\.(imdb|themoviedb|thetvdb):\/\/([^?]+)/;
const LEGACY_SCHEME: Record<string, string> = { imdb: "imdb", themoviedb: "tmdb", thetvdb: "tvdb" };

/** Every external id an item carries, as scheme://id in lower case. */
function externalIds(item: PlexMetadata): string[] {
  const ids = (item.Guid ?? []).map((guid) => guid.id.toLowerCase());
  const legacy = item.guid && LEGACY_AGENT_GUID.exec(item.guid);
  if (legacy) ids.push(`${LEGACY_SCHEME[legacy[1]!]}://${legacy[2]!.toLowerCase()}`);
  return ids;
}

/** Look a title up by an id Plex holds for it (imdb://tt0113277).
 *  Plex's guid= filter matches only an item's own plex:// guid, never these,
 *  so each movie and show section is read with its Guid tags and matched
 *  here. Sections on a personal-media agent, and music and photo sections,
 *  carry no such ids and are skipped. Every section is read in full: the same
 *  title can sit in two libraries. */
async function byExternalId(root: PlexClient, externalId: string, limit: number) {
  const parsed = EXTERNAL_ID.exec(externalId.trim())?.groups;
  if (!parsed) throw new Error(`externalId "${externalId}" is not one of imdb:tt0113277, tmdb:949 or tvdb:12345.`);
  const guid = `${parsed.scheme}://${parsed.id}`.toLowerCase();
  const groups: Record<string, unknown[]> = {};
  for (const section of await root.sections()) {
    if ((section.type !== "movie" && section.type !== "show") || hasPersonalMediaAgent(section)) continue;
    const items = await root.plexAll(`/library/sections/${section.key}/all`, { includeGuids: 1 });
    for (const item of items) {
      if (!("ratingKey" in item) || !externalIds(item).includes(guid)) continue;
      const group = (groups[item.type + "s"] ??= []);
      if (group.length < limit) group.push({ ...itemDict(item, false), library: item.librarySectionTitle ?? section.title });
    }
  }
  return groups;
}

export function readTools(root: PlexClient) {
  return {
    list_libraries: defineTool({
      title: "List libraries",
      annotations: READ_ONLY,
      description:
        "List all Plex library sections. libraryType is the type as Plex names it " +
        "in the UI (Movies, TV Shows, Music, Photos, Other Videos) and is the " +
        "field to read when deciding how to treat a library. Do NOT infer that from " +
        "`type`: `type` is the underlying scanner type, and an Other Videos library " +
        "(home videos, concerts, workout clips, YouTube rips) reports type 'movie' " +
        "exactly like a real Movies library. agent/scanner are the raw fields " +
        "libraryType is derived from. Also returns key and whether a scan is running " +
        "(refreshing).",
      inputSchema: {},
      // fresh fetch, not root.sections(): the cache would keep `refreshing` stale forever
      handler: async () => {
        const directories = (await root.plex("/library/sections")).Directory ?? [];
        return directories.map(sectionDict);
      },
    }),

    list_media: defineTool({
      title: "List media",
      annotations: READ_ONLY,
      description:
        "List items from any library with rich filtering. Returns watched state, " +
        "view counts and last-viewed on every record. watched defaults to 'all': " +
        "the full library, seen and unseen. For SHOW libraries: the watched filter " +
        "means any-episode-played (watched) / has-unplayed-episodes (unwatched), " +
        "while each record's watched field means fully watched. A partially-watched " +
        "show matches both filters' opposites. kind defaults to the library's natural " +
        "top-level type (movie/show/artist). Use episode/track/album/season for " +
        "deeper types, or collection to list a section's collections. " +
        "rated filters on the owner's star rating (userRating, 1-10 internal scale). " +
        "Movie records carry userRating, and sort=userRating asc puts unrated first. " +
        `Filters combine (AND). Paginate with offset/limit. ${DETAIL_FIELDS_CLAUSE} ` +
        "kind=collection lists a section's collections only. Other filters/sort are " +
        "ignored for collections.",
      inputSchema: {
        ...FILTER_SCHEMA,
        sort: z.enum(SORT_KEYS).default("addedAt"),
        order: z.enum(["asc", "desc"]).default("desc"),
        user: HOME_USER_SCHEMA,
        ...pageSchema,
      },
      handler: async (args) => {
        const client = await root.as(args.user);
        const section = await client.sectionByTitle(args.library);
        const limit = effLimit(args.limit, args.detail);
        if (args.kind === "collection") {
          const container = await client.plex(`/library/sections/${section.key}/collections`, {}, { start: args.offset, size: limit });
          return page(container, args.offset, args.detail, args.fields);
        }
        const kind = args.kind ?? sectionKind(section.type);
        const tagIds = await resolveFilterTags(client, section.key, args);
        const container = await client.plex(`/library/sections/${section.key}/all`, listParams({ ...args, kind }, tagIds), {
          start: args.offset, size: limit,
        });
        return page(args.detail ? await withCollections(client, container) : container, args.offset, args.detail, args.fields);
      },
    }),

    library_changes: defineTool({
      title: "Library changes",
      annotations: READ_ONLY,
      description:
        "What changed in a library since a cutoff: 'added' (new items) and 'updated' " +
        "(pre-existing items whose metadata changed since then). The buckets never " +
        "overlap. Caveat: Plex bumps updatedAt during routine background refreshes, " +
        "so 'updated' can include items with no meaningful change. since accepts ISO " +
        "date or relative like '-7d'. kind is movie, show, season, episode, artist, " +
        "album or track, and defaults to the library's own kind. Use episode in a " +
        "show library to see new episodes. For a library's collections, use " +
        `list_media with kind 'collection'. limit applies to each bucket. ${DETAIL_FIELDS_CLAUSE}`,
      inputSchema: {
        library: z.string().default("Movies"),
        since: z.string().default("-7d"),
        kind: z.enum(CHANGE_KINDS).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        detail: z.boolean().default(false),
      },
      handler: async (args) => {
        const section = await root.sectionByTitle(args.library);
        const kind = args.kind ?? sectionKind(section.type);
        const cutoff = sinceValue(args.since);
        const limit = effLimit(args.limit, args.detail);
        const bucket = async (params: Query, sort: string) => {
          const listing = await root.plex(`/library/sections/${section.key}/all`,
            { type: KIND_TYPE[kind], ...params, sort }, { start: 0, size: limit });
          const container = args.detail ? await withCollections(root, listing) : listing;
          const items = (container.Metadata ?? []).map((item) => ({ ...itemDict(item, args.detail), updatedAt: iso(item.updatedAt) }));
          return { total: container.totalSize ?? container.size ?? items.length, returned: items.length, items };
        };
        return {
          library: section.title,
          since: args.since,
          added: await bucket({ "addedAt>>": cutoff }, "addedAt:desc"),
          updated: await bucket({ "updatedAt>>": cutoff, "addedAt<<": cutoff }, "updatedAt:desc"),
        };
      },
    }),

    search: defineTool({
      title: "Search",
      annotations: READ_ONLY,
      description:
        "Global search across ALL libraries (movies, shows, episodes, music, " +
        "people, collections, playlists). Returns hits grouped by type. Use " +
        "person hits with person_credits. Use item hits with get_item. Pass " +
        "externalId instead of query to ask whether the library holds a title " +
        "you have an IMDb, TMDB or TVDB id for ('imdb:tt0113277', 'tmdb:949', " +
        "'tvdb:12345'): it matches the ids Plex already holds on every movie " +
        "and show library and returns the matching movies/shows, usually " +
        "one item or none. It reads every movie and show library in full, so it " +
        "takes a second or two on a large server.",
      inputSchema: {
        query: z.string().optional(),
        externalId: z.string().optional().describe("imdb:tt0113277, tmdb:949 or tvdb:12345. Look a title up by its id instead of a query"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      handler: async ({ query, externalId, limit }) => {
        if (query !== undefined && externalId !== undefined) throw new Error("search takes query or externalId, not both.");
        if (externalId !== undefined) return byExternalId(root, externalId, limit);
        if (!query?.trim()) throw new Error("search needs a query or externalId.");
        const container = await root.plex("/hubs/search", { query, limit });
        const groups: Record<string, unknown[]> = {};
        for (const hub of container.Hub ?? []) {
          if (!hub.size) continue;
          const entries = hub.Metadata ?? hub.Directory ?? [];
          const hubType = hub.type ?? "unknown";
          if (["actor", "director", "writer", "genre"].includes(hubType)) {
            groups[hubType + "s"] = [...new Map(entries.map((entry) => [entry.id ?? entry.key, { name: entry.tag ?? entry.title, id: entry.id ?? entry.key }])).values()];
          } else {
            groups[hubType + "s"] = entries.filter((entry): entry is PlexMetadata => entry.title !== undefined && entry.type !== undefined).map((item) => ({
              ...itemDict(item, false),
              library: item.librarySectionTitle ?? null,
            }));
          }
        }
        return groups;
      },
    }),

    get_item: defineTool({
      title: "Get item",
      annotations: READ_ONLY,
      description:
        "Full metadata for one item by ratingKey (any kind). Movies include " +
        "file paths/codec/size. Shows include watch progress (episodes watched / total).",
      inputSchema: { ratingKey: PLEX_ID },
      handler: async ({ ratingKey }) => {
        const noItem = () => new Error(`No item with ratingKey ${ratingKey}`);
        // Plex answers 404 for a ratingKey it has nothing for.
        const container = await root.plex(`/library/metadata/${ratingKey}`).catch((error) => {
          throw isNotFound(error) ? noItem() : error;
        });
        const item = container.Metadata?.[0];
        if (!item) throw noItem();
        const record = itemDict(item, true);
        // An item can hold several versions (4K + 1080p). Every version is
        // reported, and sizeGB sums all of them.
        const gb = (bytes: number) => Math.round((bytes / 1e9) * 100) / 100;
        const versions = (item.Media ?? []).map((media) => ({
          resolution: media.videoResolution ?? null,
          codec: media.videoCodec ?? null,
          audioCodec: media.audioCodec ?? null,
          sizeGB: gb((media.Part ?? []).reduce((sum, part) => sum + (part.size ?? 0), 0)),
          paths: (media.Part ?? []).flatMap((part) => part.file ? [part.file] : []),
        }));
        if (versions.length) {
          // The top level carries the first version's resolution and codecs,
          // with sizeGB and paths totalled across every version.
          record.file = {
            ...versions[0],
            sizeGB: gb((item.Media ?? []).flatMap((media) => media.Part ?? []).reduce((sum, part) => sum + (part.size ?? 0), 0)),
            paths: versions.flatMap((version) => version.paths),
            versionCount: versions.length,
            ...(versions.length > 1 && { versions }),
          };
        }
        return record;
      },
    }),

    get_extras: defineTool({
      title: "Get extras",
      annotations: READ_ONLY,
      description:
        "Extras (trailers, featurettes, behind-the-scenes, deleted scenes) for " +
        "one item by ratingKey. Local extras include file paths. Plex-provided " +
        "streaming trailers have no local file (paths is empty).",
      inputSchema: { ratingKey: PLEX_ID },
      handler: async ({ ratingKey }) => {
        const container = await root.plex(`/library/metadata/${ratingKey}/extras`);
        return { total: container.size ?? 0, extras: (container.Metadata ?? []).map(extraDict) };
      },
    }),

    get_children: defineTool({
      title: "Get children",
      annotations: READ_ONLY,
      description:
        "Children of a container: show→seasons, season→episodes, artist→albums, " +
        "album→tracks, collection→items. Set playlist=true when ratingKey is a " +
        `playlist. Paginated. ${DETAIL_FIELDS_CLAUSE}`,
      inputSchema: {
        ratingKey: PLEX_ID,
        playlist: z.boolean().default(false),
        ...pageSchema,
      },
      handler: async (args) => {
        const path = args.playlist
          ? `/playlists/${args.ratingKey}/items`
          : `/library/metadata/${args.ratingKey}/children`;
        const container = await root.plex(path, {}, { start: args.offset, size: effLimit(args.limit, args.detail) });
        return page(args.detail ? await withCollections(root, container) : container, args.offset, args.detail, args.fields);
      },
    }),

    person_credits: defineTool({
      title: "Person credits",
      annotations: READ_ONLY,
      description:
        "Everything by a person (director, actor, writer, or composer) within " +
        "one library, with optional watched filter. 'Scorsese films I haven't " +
        `seen' = role:director, watched:'unwatched'. Paginated. ${DETAIL_FIELDS_CLAUSE}`,
      inputSchema: {
        name: nonBlank("name"),
        role: z.enum(["director", "actor", "writer", "composer"]).default("director"),
        library: z.string().default("Movies"),
        watched: z.enum(["all", "watched", "unwatched"]).default("all"),
        sort: z.enum(SORT_KEYS).default("year"),
        order: z.enum(["asc", "desc"]).default("asc"),
        ...pageSchema,
      },
      handler: async (args) => {
        const section = await root.sectionByTitle(args.library);
        // hubs/search only emits director/actor hubs. A writer or composer
        // must resolve via the section's tag list.
        const person = ["director", "actor"].includes(args.role)
          ? await root.resolvePerson(args.name, args.role)
          : await root.resolveSectionTag(section.key, args.role, args.name).catch((error) => {
              // some servers don't index writer/composer tags at all → Plex 404
              if (isNotFound(error)) {
                throw new Error(`Library "${section.title}" has no ${args.role} index on this Plex server.`);
              }
              throw error;
            });
        const kind = sectionKind(section.type);
        const container = await root.plex(
          `/library/sections/${section.key}/all`,
          listParams({ kind, watched: args.watched, sort: args.sort, order: args.order }, { [args.role]: person.id }),
          { start: args.offset, size: effLimit(args.limit, args.detail) }
        );
        return { person: person.name, role: args.role, ...page(args.detail ? await withCollections(root, container) : container, args.offset, args.detail, args.fields) };
      },
    }),

    library_stats: defineTool({
      title: "Library stats",
      annotations: READ_ONLY,
      description:
        "Aggregate stats for a library: totals, watched AND unwatched counts, " +
        "genre/decade/contentRating breakdowns. includeUserStats=true adds " +
        "per-user play counts from watch history (recent 10,000 plays).",
      inputSchema: {
        library: z.string().default("Movies"),
        includeUserStats: z.boolean().default(false),
        user: HOME_USER_SCHEMA,
      },
      handler: async ({ library, includeUserStats, user }) => {
        const client = await root.as(user);
        const section = await client.sectionByTitle(library);
        // Movie, show and artist sections have a kind of their own to count.
        // Any other section type is refused rather than counted as movies.
        if (!hasDefaultKind(section.type)) {
          throw new Error(`library_stats does not support "${section.title}" (a ${libraryType(section)} library). It supports Movies, TV Shows, Other Videos, and Music only.`);
        }
        const genres: Record<string, number> = {}, decades: Record<string, number> = {}, ratings: Record<string, number> = {};
        let total = 0, watched = 0, episodes = 0, episodesWatched = 0;
        const items = await client.plexAll(`/library/sections/${section.key}/all`, { type: KIND_TYPE[sectionKind(section.type)] });
        for (const item of items.filter((entry): entry is PlexMetadata => "ratingKey" in entry)) {
          total++;
          if (section.type === "show") {
            episodes += item.leafCount ?? 0;
            episodesWatched += item.viewedLeafCount ?? 0;
          }
          if (isWatched(item)) watched++;
          for (const genre of (item.Genre ?? []).map((tag) => tag.tag)) genres[genre] = (genres[genre] ?? 0) + 1;
          if (item.year) {
            const decade = `${Math.floor(item.year / 10) * 10}s`;
            decades[decade] = (decades[decade] ?? 0) + 1;
          }
          if (item.contentRating) ratings[item.contentRating] = (ratings[item.contentRating] ?? 0) + 1;
        }
        const desc = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).sort((left, right) => right[1] - left[1]));
        const stats: {
          library: string;
          total: number;
          watched: number;
          unwatched: number;
          episodes?: number;
          episodesWatched?: number;
          genres: Record<string, number>;
          decades: Record<string, number>;
          contentRatings: Record<string, number>;
          playsByUser?: Record<string, number>;
        } = {
          library: section.title,
          total,
          watched,
          unwatched: total - watched,
          ...(section.type === "show" && { episodes, episodesWatched }),
          genres: desc(genres),
          decades: Object.fromEntries(Object.entries(decades).sort((left, right) => left[0].localeCompare(right[0]))),
          contentRatings: desc(ratings),
        };
        if (includeUserStats) {
          const names = Object.fromEntries((await client.accounts()).map((account) => [account.id, account.name]));
          const byUser: Record<string, number> = {};
          for (let start = 0; start < 10_000; start += 500) {
            const container = await client.plex("/status/sessions/history/all",
              { librarySectionID: section.key, sort: "viewedAt:desc" }, { start, size: 500 });
            const rows = container.Metadata ?? [];
            for (const play of rows) {
              const name = playUser(play.accountID, names);
              byUser[name] = (byUser[name] ?? 0) + 1;
            }
            if (rows.length < 500) break;
          }
          stats.playsByUser = desc(byUser);
        }
        return stats;
      },
    }),
  };
}
