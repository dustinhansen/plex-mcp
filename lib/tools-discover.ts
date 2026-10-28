/** Recommendation helpers built on the read tools. */
import { z } from "zod";
import { listParams, sectionKind } from "./filters.js";
import { itemDict, isWatched, iso, mins } from "./format.js";
import { DETAIL_CAP_CLAUSE, DETAIL_FIELDS_PHRASE, effLimit, FILTER_SCHEMA, HOME_USER_SCHEMA, resolveFilterTags, withCollections } from "./tools-read.js";
import { defineTool, PLEX_ID, READ_ONLY } from "../types/tool-registration.js";
import type { PlexClient, PlexMetadata } from "../types/boundaries.js";

const continueDict = (item: PlexMetadata) => ({
  show: item.grandparentTitle ?? null,
  season: item.parentIndex ?? null,
  episode: item.index ?? null,
  title: item.title,
  ratingKey: item.ratingKey,
  viewOffsetMin: mins(item.viewOffset) ?? 0,
  durationMin: mins(item.duration) ?? 0,
  lastViewedAt: iso(item.lastViewedAt),
  library: item.librarySectionTitle ?? null,
});

export function discoverTools(root: PlexClient) {
  return {
    similar_items: defineTool({
      title: "Similar items",
      annotations: READ_ONLY,
      description:
        "Plex's 'more like this' list for one item (movie, show, album…) by " +
        "ratingKey, from your own library only. watched filters the results so " +
        "'similar but unseen' is one call.",
      inputSchema: {
        ratingKey: PLEX_ID,
        watched: z.enum(["all", "watched", "unwatched"]).default("all"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ ratingKey, watched, limit }) => {
        const container = await root.plex(`/library/metadata/${ratingKey}/similar`);
        const items = (container.Metadata ?? [])
          .filter((item) => watched === "all" || isWatched(item) === (watched === "watched"))
          .slice(0, limit)
          .map((item) => itemDict(item, false));
        return { ratingKey, total: items.length, items };
      },
    }),

    random_pick: defineTool({
      title: "Random pick",
      annotations: READ_ONLY,
      description:
        "N random items matching the same filters as list_media (the 'just pick " +
        "something' tool). Defaults to 3 picks. Combine watched=unwatched with genre, " +
        "decade, maxDurationMin etc. user picks as a Plex Home user, so unwatched " +
        "means unwatched by them. Each pick is the record list_media returns " +
        "(title, year, watched state, genres, duration and so on). detail=true " +
        `adds ${DETAIL_FIELDS_PHRASE} so you can explain the pick.`,
      inputSchema: {
        ...FILTER_SCHEMA,
        count: z.number().int().min(1).max(10).default(3),
        detail: z.boolean().default(false),
        user: HOME_USER_SCHEMA,
      },
      handler: async (args) => {
        const client = await root.as(args.user);
        const section = await client.sectionByTitle(args.library);
        const kind = args.kind ?? sectionKind(section.type);
        const tagIds = await resolveFilterTags(client, section.key, args);
        const params = listParams({ ...args, kind, sort: "random" }, tagIds);
        const listing = await client.plex(`/library/sections/${section.key}/all`, params, { start: 0, size: args.count });
        const container = args.detail ? await withCollections(client, listing) : listing;
        return { library: section.title, picks: (container.Metadata ?? []).map((item) => itemDict(item, args.detail)) };
      },
    }),

    get_watchlist: defineTool({
      title: "Watchlist",
      annotations: READ_ONLY,
      description:
        "The server owner's plex.tv watchlist, newest first. Each entry says " +
        "whether the title is in a library here (inLibrary) and gives its " +
        "ratingKey if so. Titles not in any library have ratingKey null. " +
        "Paginate with offset/limit.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
      handler: async ({ offset, limit }) => {
        const { totalSize, size, items } = await root.watchlist({ start: offset, size: limit });
        // One lookup per entry: the server matches a Plex GUID across every
        // library. Ten at a time, so a full page doesn't hit the server at once.
        const entries = [];
        for (let start = 0; start < items.length; start += 10) {
          entries.push(...await Promise.all(items.slice(start, start + 10).map(async (item) => {
            const ratingKey = (await root.plex("/library/all", { guid: item.guid })).Metadata?.[0]?.ratingKey ?? null;
            return { title: item.title, year: item.year ?? null, kind: item.type, inLibrary: ratingKey !== null, ratingKey };
          })));
        }
        // The next page starts after everything plex.tv sent, kept or not.
        const next = offset + size;
        return { total: totalSize, offset, returned: entries.length, nextOffset: next < totalSize ? next : null, items: entries };
      },
    }),

    continue_watching: defineTool({
      title: "Continue watching",
      annotations: READ_ONLY,
      description:
        "What to continue tonight: the next unwatched episode for every show in " +
        "progress (and partially-watched movies), with how far in you are. Optional " +
        "library narrows to one section. user shows a Plex Home user's list. " +
        `${DETAIL_CAP_CLAUSE} and returns full item records (watched, viewCount, ` +
        "actors, collections…) instead of the progress fields.",
      inputSchema: {
        library: z.string().optional(),
        user: HOME_USER_SCHEMA,
        limit: z.number().int().min(1).max(100).default(20),
        detail: z.boolean().default(false),
      },
      handler: async ({ library, user, limit, detail }) => {
        const client = await root.as(user);
        const path = library ? `/library/sections/${(await client.sectionByTitle(library)).key}/onDeck` : "/library/onDeck";
        const listing = await client.plex(path, {}, { start: 0, size: effLimit(limit, detail) });
        if (!detail) return { user: user ?? null, items: (listing.Metadata ?? []).map(continueDict) };
        const container = await withCollections(client, listing);
        return { user: user ?? null, items: (container.Metadata ?? []).map((item) => itemDict(item, true)) };
      },
    }),
  };
}
