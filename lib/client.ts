/** Plex HTTP client. fetch is injected for testability.
 *  Container paging needs both X-Plex-Container-Start and
 *  X-Plex-Container-Size. With one of them, Plex returns the whole listing. */

import type {
  FetchLike, PlexAccount, PlexClient, PlexClientOptions, PlexDirectory, PlexHub,
  PlexHubItem, PlexItem, PlexMediaContainer, PlexMetadata, PlexPlayer, PlexRequestOptions, PlexSection, PlexTvHomeUser, Query,
} from "../types/boundaries.js";
import { isNumber, isRecord, isString, parseAll, parseUpstreamJson } from "./guards.js";
import { upstreamText } from "./upstream.js";

const stringOrUndefined = (value: unknown): string | undefined => isString(value) ? value : undefined;
const numberOrUndefined = (value: unknown): number | undefined => isNumber(value) ? value : undefined;
const idOrUndefined = (value: unknown): string | number | undefined => isString(value) || isNumber(value) ? value : undefined;

const tagFromJson = (value: unknown) => isRecord(value) && isString(value.tag) ? { tag: value.tag } : undefined;
const guidFromJson = (value: unknown) => isRecord(value) && isString(value.id) ? { id: value.id } : undefined;
const tagsFromJson = (value: unknown) => Array.isArray(value) ? parseAll(value, tagFromJson) : undefined;
const guidsFromJson = (value: unknown) => Array.isArray(value) ? parseAll(value, guidFromJson) : undefined;

function partFromJson(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    file: stringOrUndefined(value.file),
    size: numberOrUndefined(value.size),
  };
}

function mediaItemFromJson(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    videoResolution: stringOrUndefined(value.videoResolution),
    videoCodec: stringOrUndefined(value.videoCodec),
    audioCodec: stringOrUndefined(value.audioCodec),
    Part: Array.isArray(value.Part) ? parseAll(value.Part, partFromJson) : undefined,
  };
}

const mediaFromJson = (value: unknown) => Array.isArray(value) ? parseAll(value, mediaItemFromJson) : undefined;

function metadataFromJson(value: unknown): PlexMetadata | undefined {
  if (!isRecord(value) || !isString(value.title) || !isString(value.type)) return undefined;
  return {
    title: value.title,
    type: value.type,
    guid: stringOrUndefined(value.guid),
    ratingKey: stringOrUndefined(value.ratingKey),
    playlistItemID: idOrUndefined(value.playlistItemID)?.toString(),
    librarySectionTitle: stringOrUndefined(value.librarySectionTitle),
    year: numberOrUndefined(value.year),
    viewCount: numberOrUndefined(value.viewCount),
    lastViewedAt: numberOrUndefined(value.lastViewedAt),
    addedAt: numberOrUndefined(value.addedAt),
    updatedAt: numberOrUndefined(value.updatedAt),
    leafCount: numberOrUndefined(value.leafCount),
    viewedLeafCount: numberOrUndefined(value.viewedLeafCount),
    childCount: numberOrUndefined(value.childCount),
    parentTitle: stringOrUndefined(value.parentTitle),
    grandparentTitle: stringOrUndefined(value.grandparentTitle),
    parentIndex: numberOrUndefined(value.parentIndex),
    index: numberOrUndefined(value.index),
    rating: numberOrUndefined(value.rating),
    audienceRating: numberOrUndefined(value.audienceRating),
    userRating: numberOrUndefined(value.userRating),
    contentRating: stringOrUndefined(value.contentRating),
    duration: numberOrUndefined(value.duration),
    playlistType: stringOrUndefined(value.playlistType),
    subtype: stringOrUndefined(value.subtype),
    studio: stringOrUndefined(value.studio),
    summary: stringOrUndefined(value.summary),
    accountID: numberOrUndefined(value.accountID),
    viewedAt: numberOrUndefined(value.viewedAt),
    viewOffset: numberOrUndefined(value.viewOffset),
    Genre: tagsFromJson(value.Genre),
    Director: tagsFromJson(value.Director),
    Writer: tagsFromJson(value.Writer),
    Role: tagsFromJson(value.Role),
    Country: tagsFromJson(value.Country),
    Collection: tagsFromJson(value.Collection),
    Guid: guidsFromJson(value.Guid),
    Media: mediaFromJson(value.Media),
    User: isRecord(value.User) ? {
      title: stringOrUndefined(value.User.title),
    } : undefined,
    Player: isRecord(value.Player) ? {
      product: stringOrUndefined(value.Player.product),
      state: stringOrUndefined(value.Player.state),
    } : undefined,
  };
}

function directoryFromJson(value: unknown): PlexDirectory | undefined {
  if (!isRecord(value) || !isString(value.title) || !isString(value.key)) return undefined;
  return {
    title: value.title,
    key: value.key,
    id: idOrUndefined(value.id),
    tag: stringOrUndefined(value.tag),
    type: stringOrUndefined(value.type),
    agent: stringOrUndefined(value.agent),
    scanner: stringOrUndefined(value.scanner),
    refreshing: isNumber(value.refreshing) || typeof value.refreshing === "boolean" ? value.refreshing : undefined,
  };
}

/** A hub entry is a person/tag (id + tag) or a full metadata item, which a
 *  search result needs whole or item hubs come back empty. */
function hubItemFromJson(value: unknown): PlexHubItem | undefined {
  if (!isRecord(value)) return undefined;
  const sourceId = idOrUndefined(value.id) ?? idOrUndefined(value.key);
  const sourceName = isString(value.tag) ? value.tag : value.title;
  const tag = sourceId !== undefined && isString(sourceName) ? { id: sourceId, tag: sourceName } : undefined;
  const metadata = metadataFromJson(value);
  return tag || metadata ? { ...metadata, ...tag } : undefined;
}

const isPlexDirectory = (value: PlexItem): value is PlexDirectory => "key" in value;

function accountFromJson(value: unknown): PlexAccount | undefined {
  if (!isRecord(value) || !isNumber(value.id)) return undefined;
  return {
    id: value.id,
    name: stringOrUndefined(value.name),
  };
}

function hubFromJson(value: unknown): PlexHub | undefined {
  if (!isRecord(value)) return undefined;
  const items = (entries: unknown) => Array.isArray(entries) ? parseAll(entries, hubItemFromJson) : undefined;
  return {
    type: stringOrUndefined(value.type),
    size: numberOrUndefined(value.size),
    Directory: items(value.Directory),
    Metadata: items(value.Metadata),
  };
}

function playerFromJson(value: unknown): PlexPlayer | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.machineIdentifier)) return undefined;
  return {
    name: value.name,
    machineIdentifier: value.machineIdentifier,
    product: stringOrUndefined(value.product),
    platform: stringOrUndefined(value.platform),
    address: stringOrUndefined(value.address),
    port: numberOrUndefined(value.port),
    protocolCapabilities: stringOrUndefined(value.protocolCapabilities),
  };
}

function mediaContainerFromJson(value: unknown): PlexMediaContainer {
  if (!isRecord(value)) return {};
  const container: PlexMediaContainer = {};
  if (Array.isArray(value.Metadata)) container.Metadata = parseAll(value.Metadata, metadataFromJson);
  if (Array.isArray(value.Directory)) container.Directory = parseAll(value.Directory, directoryFromJson);
  if (Array.isArray(value.Account)) container.Account = parseAll(value.Account, accountFromJson);
  if (Array.isArray(value.Hub)) container.Hub = parseAll(value.Hub, hubFromJson);
  if (Array.isArray(value.Server)) container.Server = parseAll(value.Server, playerFromJson);
  if (isNumber(value.totalSize)) container.totalSize = value.totalSize;
  if (isNumber(value.size)) container.size = value.size;
  if (isString(value.machineIdentifier)) container.machineIdentifier = value.machineIdentifier;
  if (isNumber(value.playQueueID)) container.playQueueID = value.playQueueID;
  return container;
}

function parseMediaContainer(text: string, path: string): PlexMediaContainer {
  const payload = parseUpstreamJson(text, "Plex", path);
  return isRecord(payload) ? mediaContainerFromJson(payload.MediaContainer) : {};
}

export function makeClient({ baseUrl, token, fetchImpl = globalThis.fetch as FetchLike, plextv = null }: PlexClientOptions): PlexClient {
  const base = baseUrl.replace(/\/$/, "");
  let cachedSections: PlexSection[] | undefined;
  let cachedAccounts: Array<{ id: number; name: string }> | undefined;
  let cachedMachineId: string | undefined;
  let cachedHomeUsers: PlexTvHomeUser[] | undefined;
  const userClients = new Map<number, PlexClient>();
  const pendingSwitches = new Map<number, Promise<PlexClient>>();

  async function plex(
    path: string,
    params: Query = {},
    { start, size, method = "GET", headers: extra = {} }: PlexRequestOptions = {},
  ): Promise<PlexMediaContainer> {
    // The path is judged alone, before params add a query of their own.
    const url = new URL(base + path);
    if (url.search || url.hash || url.pathname !== new URL(base).pathname.replace(/\/$/, "") + path) {
      throw new Error(`Plex request path ${path} does not resolve to itself`);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json", "X-Plex-Token": token, ...extra };
    if (size !== undefined) {
      headers["X-Plex-Container-Start"] = String(start ?? 0);
      headers["X-Plex-Container-Size"] = String(size);
    }
    const text = await upstreamText(fetchImpl, "Plex", path, url, { method, headers });
    return text ? parseMediaContainer(text, path) : {};
  }

  /** maxPages bounds the walk. Plex silently ignores parameters it doesn't
   *  support (`viewedAt>>` on the history endpoint returns
   *  everything), so a server that ignored the container headers would page
   *  forever and exhaust memory. 200 pages x 500 = 100k items. */
  async function plexAll(path: string, params: Query = {}, { pageSize = 500, key = "Metadata", maxPages = 200 } = {}): Promise<PlexItem[]> {
    const all: PlexItem[] = [];
    for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
      const container = await plex(path, params, { start: pageNo * pageSize, size: pageSize });
      const items = key === "Metadata" ? container.Metadata ?? [] : container.Directory ?? [];
      all.push(...items);
      if (items.length < pageSize) return all;
    }
    throw new Error(`Refusing to page past ${maxPages * pageSize} items on ${path}. The server may be ignoring container headers.`);
  }

  async function sections(): Promise<PlexSection[]> {
    cachedSections ??= (await plex("/library/sections")).Directory ?? [];
    return cachedSections;
  }

  /** A name not in the cached list reads the list again once before failing,
   *  so a library, account or Home user added or renamed while the server runs
   *  is found.
   *  `all` is the list last searched, for the "not found" error to name. */
  async function findRefreshingOnMiss<T>(
    load: () => Promise<T[]>,
    reset: () => void,
    matches: (candidate: T) => boolean,
  ): Promise<{ hit: T | undefined; all: T[] }> {
    let all = await load();
    let hit = all.find(matches);
    if (!hit) {
      reset();
      all = await load();
      hit = all.find(matches);
    }
    return { hit, all };
  }

  async function sectionByTitle(title: string): Promise<PlexSection> {
    const query = title.toLowerCase();
    const { hit, all } = await findRefreshingOnMiss(
      sections,
      () => { cachedSections = undefined; },
      (candidate) => candidate.title.toLowerCase() === query,
    );
    if (!hit) throw new Error(`No library "${title}". Available: ${all.map((item) => item.title).join(", ")}`);
    return hit;
  }

  async function accounts(): Promise<Array<{ id: number; name: string }>> {
    if (!cachedAccounts) cachedAccounts = ((await plex("/accounts")).Account ?? []).map((account) => ({ id: account.id, name: account.name || "owner" }));
    return cachedAccounts;
  }

  async function accountByName(nameOrId: string): Promise<{ id: number; name: string }> {
    const query = nameOrId.toLowerCase();
    const { hit, all } = await findRefreshingOnMiss(
      accounts,
      () => { cachedAccounts = undefined; },
      (candidate) => candidate.name.toLowerCase() === query || String(candidate.id) === query,
    );
    if (!hit) throw new Error(`No user "${nameOrId}". Available: ${all.map((item) => item.name).join(", ")}`);
    return hit;
  }

  async function resolveSectionTag(sectionKey: string, tagType: string, name: string): Promise<{ id: string; name: string }> {
    const directories = (await plexAll(`/library/sections/${sectionKey}/${tagType}`, {}, { key: "Directory" })).filter(isPlexDirectory);
    const query = name.toLowerCase();
    const hit = directories.find((directory) => directory.title.toLowerCase() === query) ??
      directories.find((directory) => directory.title.toLowerCase().includes(query));
    if (!hit) {
      const near = directories.filter((directory) => directory.title.toLowerCase().startsWith(query[0] ?? "")).slice(0, 8);
      const nearMatches = near.length ? ` Near matches: ${near.map((item) => item.title).join(", ")}` : "";
      throw new Error(`No ${tagType} "${name}" in this library.` + nearMatches);
    }
    return { id: hit.key, name: hit.title };
  }

  async function resolvePerson(name: string, role: string): Promise<{ id: string | number; name: string }> {
    const hub = ((await plex("/hubs/search", { query: name, limit: 10 })).Hub ?? []).find((candidate) => candidate.type === role);
    const raw = hub?.Directory ?? hub?.Metadata ?? [];
    const people = new Map<string, { id: string | number; name: string }>();
    for (const person of raw) {
      if (person.id !== undefined && person.tag !== undefined && !people.has(String(person.id))) {
        people.set(String(person.id), { id: person.id, name: person.tag });
      }
    }
    const candidates = [...people.values()];
    const query = name.toLowerCase();
    const hit = candidates.find((person) => person.name.toLowerCase() === query) ??
      candidates.find((person) => person.name.toLowerCase().includes(query) || query.includes(person.name.toLowerCase()));
    if (!hit) {
      const found = candidates.length ? ` Found instead: ${candidates.map((person) => person.name).join(", ")}` : "";
      throw new Error(`No ${role} "${name}" found in Plex search.` + found);
    }
    return hit;
  }

  async function machineId(): Promise<string | undefined> {
    cachedMachineId ??= (await plex("/identity")).machineIdentifier;
    return cachedMachineId;
  }

  async function homeUsers(list: NonNullable<typeof plextv>): Promise<PlexTvHomeUser[]> {
    cachedHomeUsers ??= await list.homeUsers(token);
    return cachedHomeUsers;
  }

  async function as(nameOrId?: string | null): Promise<PlexClient> {
    if (nameOrId == null || nameOrId === "") return self;
    if (!plextv) {
      throw new Error("Per-user views need plex.tv access (the server was started without it)." +
        " Use watch_history, which works for every account.");
    }
    const query = nameOrId.toLowerCase();
    const { hit: user, all } = await findRefreshingOnMiss(
      () => homeUsers(plextv),
      () => { cachedHomeUsers = undefined; },
      (candidate) => candidate.title.toLowerCase() === query || String(candidate.id) === query,
    );
    if (!user) {
      const titles = all.map((item) => item.title).join(", ") || "none";
      throw new Error(`No Plex Home user "${nameOrId}". Home users: ${titles}.` +
        " Friends (shared users) cannot be impersonated. Use watch_history for them.");
    }
    // A cached entry can be stale (a PIN added or removed, a user who left the
    // Home), and that fails here, so the list is read again on the next call.
    try {
      // plex.tv switches to a protected user only with their PIN, and no tool takes one.
      if (user.protected) {
        throw new Error(`Plex Home user "${user.title}" is PIN-protected, so the server cannot view the library as them.` +
          " Use watch_history, which works for every account.");
      }
      const cached = userClients.get(user.id);
      if (cached) return cached;
      // Calls that overlap while a switch runs wait on it, so plex.tv sees one
      // switch per user. The entry goes once it settles, failed or not.
      let pending = pendingSwitches.get(user.id);
      if (!pending) {
        pending = switchTo(plextv, user).finally(() => pendingSwitches.delete(user.id));
        pendingSwitches.set(user.id, pending);
      }
      return await pending;
    } catch (error) {
      cachedHomeUsers = undefined;
      throw error;
    }
  }

  async function switchTo(tv: NonNullable<typeof plextv>, user: PlexTvHomeUser): Promise<PlexClient> {
    const id = await machineId();
    if (!id) throw new Error("The Plex server did not report its machine identifier, which per-user views need to find the user's access token.");
    const serverToken = await tv.serverToken(await tv.switchHomeUser(token, user.uuid), id);
    if (!serverToken) throw new Error(`Plex Home user "${user.title}" has no access to this server on plex.tv. Use watch_history for them.`);
    // A 401 means the user's token no longer works (access revoked), so the
    // client is dropped and the next call switches again.
    const forgetOn401: FetchLike = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (response.status === 401 && userClients.get(user.id) === userClient) userClients.delete(user.id);
      return response;
    };
    const userClient = makeClient({ baseUrl, token: serverToken, fetchImpl: forgetOn401, plextv: null });
    userClients.set(user.id, userClient);
    return userClient;
  }

  /** The watchlist belongs to the token's plex.tv account, so it is the server
   *  owner's, never a Home user's. */
  function plexTv(): NonNullable<typeof plextv> {
    if (!plextv) throw new Error("The watchlist needs plex.tv access (the server was started without it).");
    return plextv;
  }
  const watchlist: PlexClient["watchlist"] = (page) => plexTv().watchlist(token, page);
  const editWatchlist: PlexClient["editWatchlist"] = (action, guid) => plexTv().editWatchlist(token, action, guid);

  const self: PlexClient = {
    baseUrl: base,
    plex,
    plexAll,
    sections,
    sectionByTitle,
    accounts,
    accountByName,
    resolveSectionTag,
    resolvePerson,
    machineId,
    as,
    watchlist,
    editWatchlist,
  };
  return self;
}
