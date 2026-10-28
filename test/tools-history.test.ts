import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { historyTools } from "#dist/lib/tools-history.js";

type Call = { path: string; query: Record<string, string>; headers: Record<string, string> };

/** Plex-shaped responses keyed by pathname, each call recorded with its headers. */
function plexServer(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: URL, opts: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: (opts.headers ?? {}) as Record<string, string> });
    const hit = routes[u.pathname];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: hit }) };
  };
  return { calls, tools: historyTools(makeClient({ baseUrl: "http://plex.test:32400", token: "owner-tok", fetchImpl })) };
}

const ACCOUNTS = { size: 2, Account: [{ id: 1, name: "" }, { id: 7, name: "bob" }] };
const SECTIONS = { size: 1, Directory: [{ key: "2", title: "TV Shows", type: "show" }] };
const HISTORY = {
  size: 2, totalSize: 40,
  Metadata: [
    { ratingKey: "50", title: "Good News About Hell", type: "episode", grandparentTitle: "Severance", viewedAt: 1700000000, accountID: 7 },
    { ratingKey: "10", title: "Arrival", type: "movie", viewedAt: 1690000000, accountID: 1 },
  ],
};
const historyQuery = (calls: Call[]) => calls.find((c) => c.path === "/status/sessions/history/all");

test("watch_history sends each filter as the history endpoint's own parameter", async () => {
  const { calls, tools } = plexServer({ "/accounts": ACCOUNTS, "/library/sections": SECTIONS, "/status/sessions/history/all": HISTORY });
  await tools.watch_history.handler({ user: "BOB", library: "tv shows", since: "2026-06-01", until: "2026-07-01T00:00:00Z", ratingKey: "50", offset: 20, limit: 10 });
  const call = historyQuery(calls)!;
  assert.equal(call.query.sort, "viewedAt:desc");
  assert.equal(call.query.accountID, "7");
  assert.equal(call.query.librarySectionID, "2");
  assert.equal(call.query["viewedAt>"], String(Date.parse("2026-06-01") / 1000));
  assert.equal(call.query["viewedAt<"], String(Date.parse("2026-07-01T00:00:00Z") / 1000));
  assert.equal(call.query.metadataItemID, "50");
  assert.equal(call.query["viewedAt>>"], undefined, "the history endpoint ignores the double-angle form");
  assert.equal(call.headers["X-Plex-Container-Start"], "20");
  assert.equal(call.headers["X-Plex-Container-Size"], "10");
});

test("watch_history takes an account id as the user, and leaves unset filters out", async () => {
  const { calls, tools } = plexServer({ "/accounts": ACCOUNTS, "/status/sessions/history/all": HISTORY });
  await tools.watch_history.handler({ user: "7", offset: 0, limit: 50 });
  assert.deepEqual(historyQuery(calls)!.query, { sort: "viewedAt:desc", accountID: "7" });
});

test("watch_history names each play's user and filters kind on the returned page only", async () => {
  const { tools } = plexServer({ "/accounts": ACCOUNTS, "/status/sessions/history/all": HISTORY });
  const all = await tools.watch_history.handler({ offset: 0, limit: 50 });
  assert.deepEqual(all.plays.map((p) => p.user), ["bob", "owner"]);
  const episodes = await tools.watch_history.handler({ kind: "episode", offset: 0, limit: 50 });
  assert.deepEqual(episodes, {
    total: 40, offset: 0, returned: 1,
    plays: [{ title: "Good News About Hell", kind: "episode", show: "Severance", artist: null, viewedAt: "2023-11-14T22:13:20.000Z", user: "bob", accountID: 7, ratingKey: "50" }],
  });
});

test("watch_history names the known users when the user is unknown", async () => {
  const { calls, tools } = plexServer({ "/accounts": ACCOUNTS, "/status/sessions/history/all": HISTORY });
  await assert.rejects(tools.watch_history.handler({ user: "carol", offset: 0, limit: 50 }) as Promise<unknown>, /^Error: No user "carol"\. Available: owner, bob$/);
  assert.equal(historyQuery(calls), undefined);
});

test("watch_history rejects a date it cannot parse instead of dropping the filter", async () => {
  const { calls, tools } = plexServer({ "/status/sessions/history/all": HISTORY });
  await assert.rejects(tools.watch_history.handler({ since: "last tuesday", offset: 0, limit: 50 }) as Promise<unknown>, /Bad since "last tuesday"/);
  assert.equal(historyQuery(calls), undefined);
});

test("now_playing reports each session's user, player and progress", async () => {
  const { tools } = plexServer({ "/status/sessions": { size: 1, Metadata: [
    { title: "Arrival", type: "movie", duration: 6960000, viewOffset: 1740000, User: { title: "bob" }, Player: { product: "Plex for Apple TV", state: "paused" } },
  ] } });
  assert.deepEqual(await tools.now_playing.handler({}), {
    sessions: [{ user: "bob", title: "Arrival", kind: "movie", show: null, player: "Plex for Apple TV", state: "paused", progressPct: 25 }],
  });
});

test("now_playing returns no sessions when nothing is playing", async () => {
  const { tools } = plexServer({ "/status/sessions": { size: 0 } });
  assert.deepEqual(await tools.now_playing.handler({}), { sessions: [] });
});

test("list_users lists every account, naming the unnamed owner account", async () => {
  const { tools } = plexServer({ "/accounts": ACCOUNTS });
  assert.deepEqual(await tools.list_users.handler({}), [{ id: 1, name: "owner" }, { id: 7, name: "bob" }]);
});
