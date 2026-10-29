#!/usr/bin/env node
/**
 * Plex MCP server entry point.
 *
 * Full library intelligence + curation: browse/filter any media kind with
 * watched state everywhere, all-user watch history, person queries, stats,
 * and playlist/collection/watch-state/rating/watchlist writes. Nothing can delete,
 * move, or modify media files or metadata.
 *
 * Usage: plex-mcp [login [--write <file>]]
 *
 * Env vars:
 *   PLEX_URL       e.g. http://<plex-host>:32400 (anything but an http or
 *                  https URL is refused)
 *   PLEX_TOKEN     owner/admin X-Plex-Token (required for all-user history)
 *   MCP_TRANSPORT  "stdio" (default) or "http". Any other value is refused
 *   PORT           http mode listen port, 0 to 65535 (default 8627)
 *   MCP_HOST       http mode listen address (default 127.0.0.1). The image
 *                  sets 0.0.0.0
 *   MCP_PATH_SECRET  capability-URL secret, REQUIRED in http mode. Any request
 *                    path containing it is served as /mcp (for public proxies).
 *                    It is the only auth on a write-capable endpoint. At least
 *                    16 characters of letters, digits, -, _, . or ~.
 *   MCP_ALLOW_NO_AUTH=1  explicit opt-out of that requirement. Only safe when
 *                    the listener is not reachable from an untrusted network
 *   PLEX_ALLOW_PLAYBACK=1  register list_clients / play_item (off by default)
 *   PLEX_READ_ONLY=1  register no write or playback tools, whatever
 *                     PLEX_ALLOW_PLAYBACK says. Any value but 1, 0 or empty is refused
 *   TAUTULLI_URL + TAUTULLI_API_KEY  register tautulli_stats / tautulli_history.
 *                  One set without the other, or a TAUTULLI_URL that is not
 *                  http or https, is refused
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClient } from "./lib/client.js";
import { makePlexTv } from "./lib/plextv.js";
import { runLogin } from "./lib/login.js";
import { makeTautulli } from "./lib/tautulli.js";
import { buildServer, buildTools, version, type ServerOptions } from "./lib/server.js";
import { listenAddress, startHttp } from "./lib/http.js";

if (process.argv[2] === "--version") {
  console.log(version);
  process.exit(0);
}

// `plex-mcp login`: plex.tv PIN sign-in. Prints PLEX_URL / PLEX_TOKEN.
if (process.argv[2] === "login") {
  const writeFlag = process.argv.indexOf("--write");
  const writeTo = writeFlag > -1 ? process.argv[writeFlag + 1] : undefined;
  if (writeFlag > -1 && !writeTo) { console.error("usage: plex-mcp login [--write <file>]"); process.exit(2); }
  try {
    await runLogin({ plextv: makePlexTv({ version }), out: console.log, writeTo });
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const PLEX_URL = process.env.PLEX_URL ?? "";
const PLEX_TOKEN = process.env.PLEX_TOKEN ?? "";
if (!PLEX_URL || !PLEX_TOKEN) {
  console.error("PLEX_URL and PLEX_TOKEN env vars are required");
  process.exit(1);
}

// A URL that does not parse, or parses with some other scheme (`plex-host:32400`
// reads as scheme `plex-host:`), would otherwise start and fail on the first
// tool call with an error that names no variable. Nothing is fetched here.
for (const name of ["PLEX_URL", "TAUTULLI_URL"]) {
  const value = process.env[name];
  if (!value) continue;
  let protocol = "";
  try { protocol = new URL(value).protocol; } catch { /* refused below */ }
  if (protocol !== "http:" && protocol !== "https:") {
    console.error(`${name} must be an http or https URL, not "${value}"`);
    process.exit(1);
  }
}

// A restriction that fails open is worse than none, so a PLEX_READ_ONLY value
// that is not 1, 0 or empty stops the server instead of starting it with writes.
const readOnlyFlag = process.env.PLEX_READ_ONLY ?? "";
if (!["", "0", "1"].includes(readOnlyFlag)) {
  console.error(`PLEX_READ_ONLY must be 1, 0 or empty, not "${readOnlyFlag}"`);
  process.exit(1);
}

// Anything but stdio or http would otherwise start a stdio server, which in a
// container reads as a hang with no log line.
const mode = process.env.MCP_TRANSPORT || "stdio";
if (mode !== "stdio" && mode !== "http") {
  console.error(`MCP_TRANSPORT must be stdio or http, not "${mode}"`);
  process.exit(1);
}

// With only one of the pair set, the Tautulli tools would not register and
// nothing would say why, so a misspelled name reads as a missing feature.
const tautulliUrl = process.env.TAUTULLI_URL ?? "";
const tautulliKey = process.env.TAUTULLI_API_KEY ?? "";
if (!tautulliUrl !== !tautulliKey) {
  console.error("TAUTULLI_URL and TAUTULLI_API_KEY must be set together or not at all");
  process.exit(1);
}

// plex.tv access powers the per-user views (`user` params). It needs nothing
// beyond the owner token, so it is always on.
const client = makeClient({ baseUrl: PLEX_URL, token: PLEX_TOKEN, plextv: makePlexTv({ version }) });

const options: ServerOptions = {
  readOnly: readOnlyFlag === "1",
  playback: process.env.PLEX_ALLOW_PLAYBACK === "1",
  tautulli: tautulliUrl && tautulliKey ? makeTautulli({ baseUrl: tautulliUrl, apiKey: tautulliKey }) : null,
};
const surface = options.readOnly ? " (read-only)" : "";
if (mode === "http") {
  const pathSecret = process.env.MCP_PATH_SECRET || undefined;
  // Refuse to serve write-capable tools with no auth. A missing env var must
  // fail loudly rather than silently publishing an open endpoint.
  if (!pathSecret && process.env.MCP_ALLOW_NO_AUTH !== "1") {
    console.error(
      "MCP_PATH_SECRET is required in http mode. It is the only auth on a " +
        "write-capable endpoint. Set it, or set MCP_ALLOW_NO_AUTH=1 if this " +
        "listener is unreachable from untrusted networks."
    );
    process.exit(1);
  }
  // The secret is matched as a substring of the still-encoded request path, so
  // a short one matches paths it was never meant to. A character outside the
  // path-safe set can be encoded or cut off before it gets here (a space, ?
  // or # never matches at all). The message leaves the value out.
  if (pathSecret && !/^[A-Za-z0-9._~-]{16,}$/.test(pathSecret)) {
    console.error(
      "MCP_PATH_SECRET must be at least 16 characters of letters, digits, " +
        "-, _, . or ~ (openssl rand -hex 32 makes one)"
    );
    process.exit(1);
  }
  const toolNames = Object.keys(buildTools(client, options));
  let httpServer: Awaited<ReturnType<typeof startHttp>>;
  try {
    httpServer = await startHttp({
      ...listenAddress(process.env),
      pathSecret,
      createMcpServer: () => buildServer(client, options).server,
    });
  } catch (error) {
    // A bad PORT or a failed listen is refused with its 1-line message.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  // As PID 1 in a container, Node gets no default action for SIGTERM, so
  // without a handler `docker stop` waits out its grace period and kills the
  // server mid-request. Stop accepting, let in-flight responses finish, then
  // exit. A close that hangs past 5 seconds exits 1 instead. The handlers go
  // in before the listening line, so a signal sent on seeing it is caught.
  const stop = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind a TCP address");
  // The secret stays out of the log, but the path shows where it goes, so the
  // logged URL is one a client can use once the placeholder is filled in.
  const [endpointPath, authNote] = pathSecret
    ? ["/<MCP_PATH_SECRET>/mcp", ""]
    : ["/mcp", ". UNAUTHENTICATED (MCP_ALLOW_NO_AUTH=1)"];
  console.error(
    `plex-mcp ${version} listening on http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}${endpointPath}: ` +
      `${toolNames.length} tools${surface}${authNote}`
  );
} else {
  const { server, toolNames } = buildServer(client, options);
  await server.connect(new StdioServerTransport());
  console.error(`plex-mcp ${version} running (stdio): ${toolNames.length} tools${surface}`);
}
