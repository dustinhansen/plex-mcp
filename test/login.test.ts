import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, pickServerUrl } from "#dist/lib/login.js";
import type { PlexTvClient, PlexTvResource } from "#dist/types/boundaries.js";

const servers: PlexTvResource[] = [{ name: "NAS", clientIdentifier: "m1", owned: true, connections: [
  { uri: "https://1-2-3-4.plex.direct:32400", local: false },
  { uri: "http://192.0.2.5:32400", local: true },
] }];

test("pickServerUrl: prefers a local connection, falls back to remote, null when none", () => {
  assert.equal(pickServerUrl(servers[0]), "http://192.0.2.5:32400");
  assert.equal(pickServerUrl({ connections: [servers[0]!.connections[0]!] } as PlexTvResource), "https://1-2-3-4.plex.direct:32400");
  assert.equal(pickServerUrl({ connections: [] } as Partial<PlexTvResource> as PlexTvResource), null);
});

const envLines = "PLEX_URL=http://192.0.2.5:32400\nPLEX_TOKEN=tok\n";

function harness({ polls = [null, null, "tok"], resources = servers }: { polls?: Array<string | null>; resources?: PlexTvResource[] } = {}) {
  const out: string[] = [];
  let i = 0, clock = 0;
  const plextv = {
    createPin: async () => ({ id: 1, code: "CODE" }),
    authUrl: (c: string) => `https://app.plex.tv/auth#?code=${c}`,
    pollPin: async () => polls[Math.min(i++, polls.length - 1)],
    resources: async () => resources,
  } as Partial<PlexTvClient> as PlexTvClient;
  const writes: Array<{ path: string; data: string }> = [];
  return {
    out, writes,
    opts: { plextv, out: (s: string) => out.push(s), sleep: async () => { clock += 2000; }, now: () => clock, timeoutMs: 10_000,
      appendFile: async (path: string, data: string) => { writes.push({ path, data }); } },
  };
}

test("runLogin: prints the link, polls to a token, prints env lines", async () => {
  const h = harness();
  const r = await runLogin(h.opts);
  assert.equal(r.token, "tok");
  assert.equal(r.url, "http://192.0.2.5:32400");
  assert.match(h.out.join("\n"), /https:\/\/app\.plex\.tv\/auth#\?code=CODE/);
  assert.match(h.out.join("\n"), /NAS/);
  assert.match(h.out.join("\n"), /PLEX_URL=http:\/\/192\.0\.2\.5:32400/);
  assert.match(h.out.join("\n"), /PLEX_TOKEN=tok/);
  assert.equal(h.writes.length, 0);
});

test("runLogin --write appends both lines to the file", async () => {
  const h = harness();
  await runLogin({ ...h.opts, writeTo: ".env" });
  assert.equal(h.writes[0].path, ".env");
  assert.equal(h.writes[0].data, envLines);
});

test("runLogin --write creates the file readable by its owner only, and leaves an existing file's mode alone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plex-mcp-login-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ".env");
  // A umask of 077 would yield 600 even without the mode option, so pin the common default.
  const umask = process.umask(0o022);
  t.after(() => { process.umask(umask); });
  const { appendFile: _fake, ...opts } = harness().opts;

  await runLogin({ ...opts, writeTo: path });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await chmod(path, 0o640);
  await runLogin({ ...opts, writeTo: path });
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal(await readFile(path, "utf8"), envLines + envLines);
});

test("runLogin: times out with a clear error", async () => {
  const h = harness({ polls: [null] });
  await assert.rejects(runLogin(h.opts), /timed out/i);
});

test("runLogin: no servers still prints the token", async () => {
  const h = harness({ resources: [] });
  const r = await runLogin(h.opts);
  assert.equal(r.url, null);
  assert.match(h.out.join("\n"), /PLEX_TOKEN=tok/);
  assert.match(h.out.join("\n"), /no servers/i);
});
