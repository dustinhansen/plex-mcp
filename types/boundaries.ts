/** The upstream fields the parsers read, and nothing else. */

type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;
export type PlexRequestOptions = { start?: number; size?: number; method?: string; headers?: Record<string, string> };
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (input: URL, init?: RequestInit) => Promise<FetchResponse>;
export type PlexClientOptions = { baseUrl: string; token: string; fetchImpl?: FetchLike; plextv?: PlexTvClient | null };
export type PlexTvOptions = { fetchImpl?: FetchLike; clientId?: string; product?: string; version?: string };
export type TautulliOptions = { baseUrl: string; apiKey: string; fetchImpl?: FetchLike };
type PlexTag = { tag: string };
export type PlexPart = { file?: string; size?: number };
type PlexMedia = { Part?: PlexPart[]; videoResolution?: string; videoCodec?: string; audioCodec?: string };

export type PlexMetadata = {
  title: string;
  type: string;
  guid?: string;
  ratingKey?: string;
  playlistItemID?: string;
  year?: number;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
  updatedAt?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  rating?: number;
  audienceRating?: number;
  userRating?: number;
  contentRating?: string;
  duration?: number;
  playlistType?: string;
  subtype?: string;
  studio?: string;
  summary?: string;
  accountID?: number;
  viewedAt?: number;
  viewOffset?: number;
  librarySectionTitle?: string;
  Genre?: PlexTag[];
  Director?: PlexTag[];
  Writer?: PlexTag[];
  Role?: PlexTag[];
  Country?: PlexTag[];
  Collection?: PlexTag[];
  /** External ids (imdb://, tmdb://, tvdb://). Plex sends them only with includeGuids=1. */
  Guid?: Array<{ id: string }>;
  Media?: PlexMedia[];
  User?: { title?: string };
  Player?: { product?: string; state?: string };
};

export type PlexSection = { title: string; key: string; type?: string; agent?: string; scanner?: string; refreshing?: number | boolean };
export type PlexAccount = { id: number; name?: string };
export type PlexDirectory = { title: string; key: string; id?: string | number; tag?: string; type?: string; agent?: string; scanner?: string; refreshing?: number | boolean };
export type PlexItem = PlexMetadata | PlexDirectory;
export type PlexHubItem = Partial<PlexMetadata> & { id?: string | number; tag?: string; key?: string | number };
export type PlexHub = { type?: string; size?: number; Directory?: PlexHubItem[]; Metadata?: PlexHubItem[] };
export type PlexPlayer = { name: string; machineIdentifier: string; product?: string; platform?: string; address?: string; port?: number; protocolCapabilities?: string };
export type PlexMediaContainer = {
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[] | PlexSection[];
  Account?: PlexAccount[];
  Hub?: PlexHub[];
  Server?: PlexPlayer[];
  totalSize?: number;
  size?: number;
  machineIdentifier?: string;
  playQueueID?: number;
};

export type PlexTvHomeUser = { id: number; uuid: string; title: string; admin?: boolean; restricted?: boolean; protected?: boolean };
export type PlexTvResource = { name: string; clientIdentifier: string; owned: boolean; connections: Array<{ uri: string; local: boolean }> };
export type PlexTvRawResource = { name: string; clientIdentifier: string; owned?: boolean; provides?: string; accessToken?: string; connections?: Array<{ uri: string; local?: boolean }> };
export type PlexTvPin = { id: number; code: string; authToken?: string | null };
export type PlexTvHomeResponse = { users?: PlexTvHomeUser[] };
export type PlexTvSwitchResponse = { authToken: string };
type PlexTvWatchlistItem = { guid: string; title: string; type: string; year?: number };
/** `size` counts every entry plex.tv sent for the page, including any `items` leaves out. */
export type PlexTvWatchlistPage = { totalSize: number; size: number; items: PlexTvWatchlistItem[] };
type WatchlistAction = "add" | "remove";
export type TautulliRow = { title?: string; full_title?: string; friendly_name?: string; user?: string; total_plays?: number; total_duration?: number; users_watched?: number; media_type?: string; rating_key?: string | number; date?: number; platform?: string; player?: string; percent_complete?: number; watched_status?: number; duration?: number };
export type TautulliHistory = { data?: TautulliRow[]; recordsFiltered?: number };
export type TautulliStat = { stat_id: string; rows?: TautulliRow[] };
export type TautulliResponse = { response?: { result?: string; data?: TautulliHistory | TautulliStat[] } };

export type PlexClient = {
  baseUrl: string;
  plex(path: string, params?: Query, options?: PlexRequestOptions): Promise<PlexMediaContainer>;
  plexAll(path: string, params?: Query, options?: { pageSize?: number; key?: keyof PlexMediaContainer; maxPages?: number }): Promise<PlexItem[]>;
  sections(): Promise<PlexSection[]>;
  sectionByTitle(title: string): Promise<PlexSection>;
  accounts(): Promise<Array<{ id: number; name: string }>>;
  accountByName(nameOrId: string): Promise<{ id: number; name: string }>;
  resolveSectionTag(sectionKey: string, tagType: string, name: string): Promise<{ id: string; name: string }>;
  resolvePerson(name: string, role: string): Promise<{ id: string | number; name: string }>;
  machineId(): Promise<string | undefined>;
  as(nameOrId?: string | null): Promise<PlexClient>;
  watchlist(page: { start: number; size: number }): Promise<PlexTvWatchlistPage>;
  editWatchlist(action: WatchlistAction, guid: string): Promise<void>;
};

export type PlexTvClient = {
  clientId: string;
  createPin(): Promise<{ id: number; code: string }>;
  pollPin(id: number): Promise<string | null>;
  authUrl(code: string): string;
  resources(token: string): Promise<PlexTvResource[]>;
  homeUsers(token: string): Promise<PlexTvHomeUser[]>;
  switchHomeUser(token: string, userUuid: string): Promise<string>;
  serverToken(token: string, machineId: string): Promise<string | null>;
  watchlist(token: string, page: { start: number; size: number }): Promise<PlexTvWatchlistPage>;
  editWatchlist(token: string, action: WatchlistAction, guid: string): Promise<void>;
};
export type TautulliClient = { call(cmd: string, params?: Query): Promise<TautulliHistory | TautulliStat[] | undefined> };
