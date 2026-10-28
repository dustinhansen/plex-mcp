import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PlexMediaContainer, PlexMetadata, PlexTvHomeUser, PlexTvPin, PlexTvRawResource, TautulliHistory, TautulliResponse } from "../../types/boundaries.js";

const media: PlexMetadata = { title: "Arrival", type: "movie", ratingKey: "329" };
const homeUser: PlexTvHomeUser = { id: 42, uuid: "a1b2c3d4e5f60718", title: "Alex" };
const history: TautulliHistory = { recordsFiltered: 1, data: [{ title: "Arrival", watched_status: 1 }] };
/** Representative parsed HTTP payloads accepted at the client boundaries. */
const mediaContainer: PlexMediaContainer = { Metadata: [media], Directory: [{ title: "Movies", key: "1", type: "movie" }] };
const pin: PlexTvPin = { id: 42, code: "ABCD", authToken: null };
const resource: PlexTvRawResource = { name: "NAS", clientIdentifier: "server-1", provides: "server", connections: [{ uri: "http://plex.test:32400", local: true }] };
const tautulli: TautulliResponse = { response: { result: "success", data: history } };
const output: CallToolResult = { content: [{ type: "text", text: JSON.stringify({ media, homeUser, history }) }] };

void [mediaContainer, pin, resource, tautulli, output];

// @ts-expect-error The conversion may only read properties modeled at the boundary.
media.unmodeledPlexProperty;
