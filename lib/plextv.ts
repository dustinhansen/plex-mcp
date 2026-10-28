/** plex.tv account API (v2). Separate from the server client: different host,
 *  different headers, and it never sees library data. Used for PIN sign-in,
 *  server discovery, Plex Home user switching, and the owner's watchlist. */

import { createHash } from "node:crypto";
import { hostname as osHostname, userInfo as osUserInfo } from "node:os";
import type {
  PlexTvClient, PlexTvHomeResponse, PlexTvOptions, PlexTvPin, PlexTvRawResource, PlexTvResource, PlexTvSwitchResponse, PlexTvWatchlistPage, Query,
} from "../types/boundaries.js";
import { isNumber, isRecord, isString, parseAll, parseUpstreamJson } from "./guards.js";
import { upstreamText } from "./upstream.js";

const BASE = "https://plex.tv";
/** The watchlist lives on plex.tv's Discover host, not the account API's. */
const DISCOVER = "https://discover.provider.plex.tv";

function parseJson(text: string, path: string): unknown {
  return text ? parseUpstreamJson(text, "plex.tv", path) : {};
}

function pinFromJson(value: unknown): PlexTvPin {
  if (!isRecord(value) || !isNumber(value.id) || !isString(value.code)) throw new Error("plex.tv returned an invalid PIN response");
  return { id: value.id, code: value.code, authToken: isString(value.authToken) ? value.authToken : null };
}

function pinTokenFromJson(value: unknown): string | null {
  if (!isRecord(value) || !isNumber(value.id)) throw new Error("plex.tv returned an invalid PIN response");
  return isString(value.authToken) ? value.authToken : null;
}

function connectionFromJson(value: unknown) {
  if (!isRecord(value) || !isString(value.uri)) return undefined;
  return {
    uri: value.uri,
    local: value.local === true,
  };
}

function resourceFromJson(value: unknown): PlexTvRawResource | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.clientIdentifier)) return undefined;
  return {
    name: value.name,
    clientIdentifier: value.clientIdentifier,
    owned: value.owned === true,
    provides: isString(value.provides) ? value.provides : "",
    ...(isString(value.accessToken) ? { accessToken: value.accessToken } : {}),
    connections: Array.isArray(value.connections) ? parseAll(value.connections, connectionFromJson) : [],
  };
}

const resourcesFromJson = (value: unknown): PlexTvRawResource[] => Array.isArray(value) ? parseAll(value, resourceFromJson) : [];

function homeUserFromJson(value: unknown) {
  if (!isRecord(value) || !isNumber(value.id) || !isString(value.uuid) || !isString(value.title)) return undefined;
  return {
    id: value.id,
    uuid: value.uuid,
    title: value.title,
    admin: value.admin === true,
    restricted: value.restricted === true,
    protected: value.protected === true,
  };
}

function homeUsersFromJson(value: unknown): PlexTvHomeResponse {
  if (!isRecord(value) || !Array.isArray(value.users)) return {};
  return { users: parseAll(value.users, homeUserFromJson) };
}

function switchResponseFromJson(value: unknown): PlexTvSwitchResponse {
  if (!isRecord(value) || !isString(value.authToken)) throw new Error("plex.tv returned an invalid Home-user token");
  return { authToken: value.authToken };
}

function watchlistItemFromJson(value: unknown) {
  if (!isRecord(value) || !isString(value.guid) || !isString(value.title) || !isString(value.type)) return undefined;
  return {
    guid: value.guid,
    title: value.title,
    type: value.type,
    ...(isNumber(value.year) ? { year: value.year } : {}),
  };
}

function watchlistFromJson(value: unknown): PlexTvWatchlistPage {
  const container = isRecord(value) && isRecord(value.MediaContainer) ? value.MediaContainer : {};
  const raw = Array.isArray(container.Metadata) ? container.Metadata : [];
  return {
    totalSize: isNumber(container.totalSize) ? container.totalSize : raw.length,
    size: raw.length,
    items: parseAll(raw, watchlistItemFromJson),
  };
}

/** plex.tv's watchlist actions take the id at the end of an item's Plex GUID
 *  (`plex://movie/<id>`), which Discover calls its ratingKey. */
function discoverId(guid: string): string {
  const id = /^plex:\/\/[a-z]+\/([^/]+)$/.exec(guid)?.[1];
  if (!id) throw new Error(`${guid} is not a Plex GUID`);
  return id;
}

/** The X-Plex-Client-Identifier for this install. plex.tv treats each
 *  identifier as one device, so each machine gets its own, and the same one
 *  across restarts. It is a hash, so the hostname and user name are not sent
 *  as they are, and it needs no file to hold it. */
export function installClientId({
  hostname = osHostname,
  userInfo = osUserInfo,
}: { hostname?: () => string; userInfo?: () => { username: string } } = {}): string {
  // Either lookup can throw (userInfo() does for a uid with no passwd entry, as
  // under `docker run --user`), and the other one still names the machine.
  const read = (lookup: () => string) => { try { return lookup(); } catch { return ""; } };
  const input = `${read(hostname)}\0${read(() => userInfo().username)}`;
  return "plex-mcp-" + createHash("sha256").update(input).digest("hex").slice(0, 16);
}

type CallOptions = { method?: string; params?: Query; token?: string; base?: string; headers?: Record<string, string> };

export function makePlexTv({
  fetchImpl = globalThis.fetch,
  clientId = installClientId(),
  product = "plex-mcp",
  version = "0",
}: PlexTvOptions = {}): PlexTvClient {
  const identity: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Product": product,
    "X-Plex-Version": version,
    "X-Plex-Platform": "Node",
    "X-Plex-Device-Name": product,
  };

  async function call(path: string, {
    method = "GET",
    params = {},
    token,
    base = BASE,
    headers: extra = {},
  }: CallOptions = {}): Promise<unknown> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
    const headers = { ...identity, ...(token ? { "X-Plex-Token": token } : {}), ...extra };
    return parseJson(await upstreamText(fetchImpl, "plex.tv", path, url, { method, headers }), path);
  }

  async function rawResources(token: string): Promise<PlexTvRawResource[]> {
    return resourcesFromJson(await call("/api/v2/resources", { token, params: { includeHttps: 1, includeRelay: 0 } }));
  }

  return {
    clientId,
    async createPin() {
      const pin = pinFromJson(await call("/api/v2/pins", { method: "POST", params: { strong: "true" } }));
      return { id: pin.id, code: pin.code };
    },
    async pollPin(id) {
      return pinTokenFromJson(await call(`/api/v2/pins/${id}`));
    },
    authUrl(code) {
      const query = new URLSearchParams({ clientID: clientId, code, "context[device][product]": product });
      return `https://app.plex.tv/auth#?${query}`;
    },
    async resources(token): Promise<PlexTvResource[]> {
      return (await rawResources(token))
        .filter((resource) => (resource.provides ?? "").split(",").includes("server"))
        .map(({ name, clientIdentifier, owned, connections }) => ({
          name,
          clientIdentifier,
          owned: owned === true,
          connections: (connections ?? []).map((connection) => ({ uri: connection.uri, local: connection.local === true })),
        }));
    },
    async homeUsers(token) {
      return homeUsersFromJson(await call("/api/v2/home/users", { token })).users ?? [];
    },
    // plex.tv addresses the switch endpoint by the user's uuid, not the numeric id.
    async switchHomeUser(token, userUuid) {
      const path = `/api/v2/home/users/${encodeURIComponent(userUuid)}/switch`;
      return switchResponseFromJson(await call(path, { method: "POST", token })).authToken;
    },
    // A switched Home user's plex.tv token is refused by the server itself. The
    // server takes the per-server access token plex.tv lists for that account.
    async serverToken(token, machineId) {
      return (await rawResources(token)).find((resource) => resource.clientIdentifier === machineId)?.accessToken ?? null;
    },
    // Discover pages like the server does: by container headers, not query parameters.
    async watchlist(token, { start, size }) {
      return watchlistFromJson(await call("/library/sections/watchlist/all", {
        token,
        base: DISCOVER,
        params: { sort: "watchlistedAt:desc" },
        headers: { "X-Plex-Container-Start": String(start), "X-Plex-Container-Size": String(size) },
      }));
    },
    // Adding an item already listed, or removing one that isn't, succeeds and changes nothing.
    async editWatchlist(token, action, guid) {
      const path = action === "add" ? "/actions/addToWatchlist" : "/actions/removeFromWatchlist";
      await call(path, { method: "PUT", token, base: DISCOVER, params: { ratingKey: discoverId(guid) } });
    },
  };
}
