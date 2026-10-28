/** `plex-mcp login`: plex.tv PIN sign-in that ends with PLEX_URL/PLEX_TOKEN
 *  lines you can paste into an MCP client config. Everything with side effects
 *  (plex.tv, clock, stdout, file append) is injected so it is unit-testable. */
import { appendFile as fsAppendFile } from "node:fs/promises";
import type { PlexTvClient, PlexTvResource } from "../types/boundaries.js";

type LoginOptions = {
  plextv: PlexTvClient;
  out?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  writeTo?: string;
  appendFile?: (path: string, data: string) => Promise<void>;
};

export function pickServerUrl(server: PlexTvResource | undefined): string | null {
  const conns = server?.connections ?? [];
  return conns.find((connection) => connection.local)?.uri ?? conns[0]?.uri ?? null;
}

export async function runLogin({
  plextv,
  out = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 5 * 60_000,
  pollMs = 2000,
  writeTo,
  // The mode applies only when the append creates the file: the token is the
  // server owner's credential, and an existing file keeps the mode set on it.
  appendFile = (path, data) => fsAppendFile(path, data, { mode: 0o600 }),
}: LoginOptions) {
  const { id, code } = await plextv.createPin();
  out(`Open this link and approve the sign-in:\n\n  ${plextv.authUrl(code)}\n\nWaiting (code ${code})…`);

  const deadline = now() + timeoutMs;
  let token = null;
  while (!token) {
    await sleep(pollMs);
    token = await plextv.pollPin(id);
    if (!token && now() >= deadline) throw new Error("Sign-in timed out. Run `plex-mcp login` again.");
  }

  const servers = await plextv.resources(token);
  let url = null;
  if (!servers.length) {
    out("Signed in, but this account has no servers. Set PLEX_URL yourself.");
  } else {
    out("Servers on this account:");
    for (const server of servers) {
      out(`  ${server.name}${server.owned ? "" : " (shared)"}: ${server.connections.map((connection) => connection.uri + (connection.local ? " (local)" : "")).join(", ") || "no connections"}`);
    }
    url = pickServerUrl(servers.find((server) => server.owned) ?? servers[0]);
  }

  const lines = [...(url ? [`PLEX_URL=${url}`] : []), `PLEX_TOKEN=${token}`];
  out(`\n${lines.join("\n")}`);
  if (writeTo) {
    await appendFile(writeTo, lines.join("\n") + "\n");
    out(`\nAppended to ${writeTo}`);
  }
  return { token, url, servers };
}
