import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTautulli } from "#dist/lib/tautulli.js";
import { tautulliTools } from "#dist/lib/tools-tautulli.js";
import { buildTools } from "#dist/lib/server.js";
import { makeClient } from "#dist/lib/client.js";
import { UpstreamError } from "#dist/lib/upstream.js";

function stub(routes: Record<string, object>) {
  const calls: URL[] = [];
  const keys: (string | null)[] = [];
  const fetchImpl = async (url: URL | string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(u);
    keys.push(new Headers(init?.headers).get("X-Api-Key"));
    const r = routes[String(u.searchParams.get("cmd"))];
    return { ok: true, status: 200, text: async () => JSON.stringify({ response: r ?? { result: "error", message: "Invalid apikey", data: null } }) };
  };
  return { calls, keys, t: makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k", fetchImpl }) };
}

test("call: GETs /api/v2 with cmd+params, returns data, throws on error result", async () => {
  const { calls, t } = stub({ get_history: { result: "success", data: { recordsFiltered: 1, data: [] } } });
  const d = await t.call("get_history", { length: 5, user: undefined });
  assert.deepEqual(d, { recordsFiltered: 1, data: [] });
  assert.equal(calls[0].pathname, "/api/v2");
  assert.equal(calls[0].searchParams.get("length"), "5");
  assert.equal(calls[0].searchParams.get("user"), null);
  await assert.rejects(t.call("nope"), /Tautulli nope did not return success/);
});

test("call: every request carries the key as X-Api-Key and never in the URL", async () => {
  const { calls, keys, t } = stub({
    get_history: { result: "success", data: { recordsFiltered: 0, data: [] } },
    get_home_stats: { result: "success", data: [] },
  });
  await t.call("get_history");
  await t.call("get_home_stats", { time_range: 7 });
  await assert.rejects(t.call("nope"));
  assert.equal(calls.length, 3);
  assert.deepEqual(keys, ["k", "k", "k"]);
  for (const url of calls) {
    assert.equal(url.searchParams.has("apikey"), false, url.href);
  }
});

// An older Tautulli answers a missing key with 400, a newer one a wrong key with 401.
for (const status of [400, 401]) {
  test(`call: a ${status} names Tautulli 2.18.0 as the first thing to check, without echoing the body`, async () => {
    const body = JSON.stringify({ response: { result: "error", message: "Parameter apikey is required", data: {} } });
    const fetchImpl = async () => ({ ok: false, status, text: async () => body });
    const t = makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k3y", fetchImpl });
    await assert.rejects(t.call("get_history"), (e: Error) => {
      assert.ok(e instanceof UpstreamError);
      assert.equal(e.status, status);
      assert.equal(e.message, `Tautulli ${status} on get_history. If every Tautulli call fails like this, check that Tautulli is 2.18.0 or later, then that TAUTULLI_API_KEY is right`);
      return true;
    });
  });
}

test("call: a failed result never echoes Tautulli's message", async () => {
  const { t } = stub({ get_history: { result: "error", message: "Invalid apikey for 192.0.2.5", data: null } });
  await assert.rejects(t.call("get_history"), (e: Error) => {
    assert.ok(!e.message.includes("Invalid apikey"), e.message);
    assert.ok(!e.message.includes("192.0.2.5"), e.message);
    return true;
  });
});

test("call: non-OK throws with status and cmd, without echoing the body or the apikey", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "<html>/srv/app/secret/path</html>" });
  const t = makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k3y", fetchImpl });
  await assert.rejects(t.call("get_history"), (e: Error) => {
    assert.equal(e.message, "Tautulli 500 on get_history");
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, 500);
    return true;
  });
});

test("call: a refused connection names Tautulli, the cause's code and the cmd, without the apikey", async () => {
  const fetchImpl = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  const t = makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k3y", fetchImpl });
  await assert.rejects(t.call("get_history"), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^Tautulli unreachable \(ECONNREFUSED\) on get_history$/);
    assert.doesNotMatch(e.message, /k3y/);
    return true;
  });
});

test("call: a timeout names Tautulli, the 30 seconds and the cmd", async () => {
  const fetchImpl = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  const t = makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k3y", fetchImpl });
  await assert.rejects(t.call("get_history"), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^Tautulli timed out after 30s on get_history$/);
    return true;
  });
});

test("call: a 2xx body that is not JSON throws naming the cmd, without echoing the body", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>/srv/app/secret/path</html>" });
  const t = makeTautulli({ baseUrl: "http://tautulli.test:8181/", apiKey: "k", fetchImpl });
  await assert.rejects(t.call("get_history"), (e: Error) => {
    assert.equal(e.message, "Tautulli returned a reply that is not JSON on get_history");
    return true;
  });
});

const homeStats = { result: "success", data: [
  { stat_id: "top_movies", rows: [{ title: "Heat", total_plays: 4, total_duration: 40000, user: "", users_watched: 2 }] },
  { stat_id: "top_users", rows: [{ friendly_name: "alice", total_plays: 30, total_duration: 9000 }] },
] };

test("tautulli_stats flattens home stats", async () => {
  const { calls, t } = stub({ get_home_stats: homeStats });
  const r = await tautulliTools(t).tautulli_stats.handler({ days: 7, count: 5 });
  assert.equal(calls[0].searchParams.get("time_range"), "7");
  assert.equal(calls[0].searchParams.get("stats_count"), "5");
  assert.deepEqual(r.stats.top_movies[0], { title: "Heat", user: null, plays: 4, hours: 11.1, usersWatched: 2 });
  assert.deepEqual(r.stats.top_users[0], { title: null, user: "alice", plays: 30, hours: 2.5, usersWatched: null });
});

test("tautulli_history maps rows and passes filters", async () => {
  const { calls, t } = stub({ get_history: { result: "success", data: { recordsFiltered: 1, data: [
    { user: "alice", full_title: "Severance - Good News About Hell", title: "Good News About Hell", date: 1700000000, platform: "tvOS", player: "Living Room", percent_complete: 98, watched_status: 1, duration: 3300, media_type: "episode", rating_key: 50 },
  ] } } });
  const r = await tautulliTools(t).tautulli_history.handler({ user: "alice", ratingKey: "50", days: 30, limit: 10 });
  assert.equal(calls[0].searchParams.get("user"), "alice");
  assert.equal(calls[0].searchParams.get("rating_key"), "50");
  assert.equal(calls[0].searchParams.get("length"), "10");
  assert.match(calls[0].searchParams.get("after")!, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(r, { total: 1, plays: [{ user: "alice", title: "Severance - Good News About Hell", kind: "episode", ratingKey: "50",
    date: "2023-11-14T22:13:20.000Z", platform: "tvOS", player: "Living Room", percentComplete: 98, watched: true, durationMin: 55 }] });
});

test("buildTools registers tautulli only when a client is supplied", () => {
  const c = makeClient({ baseUrl: "http://plex.test:32400", token: "t", fetchImpl: async () => { throw new Error("x"); } });
  assert.ok(!("tautulli_stats" in buildTools(c)));
  assert.ok("tautulli_stats" in buildTools(c, { tautulli: stub({}).t }));
});
