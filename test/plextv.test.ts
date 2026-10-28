import { test } from "node:test";
import assert from "node:assert/strict";
import { installClientId, makePlexTv } from "#dist/lib/plextv.js";
import { UpstreamError } from "#dist/lib/upstream.js";

type Call = { url: URL; method: string; headers: Record<string, string> };
type Route = object | ((u: URL, init: RequestInit) => unknown);

function stub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: URL | string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes[u.pathname];
    if (!r) return { ok: false, status: 404, text: async () => "<html>nope</html>" };
    const body = typeof r === "function" ? r(u, init) : r;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, tv: makePlexTv({ fetchImpl, clientId: "cid-1", product: "plex-mcp", version: "3.0.0" }) };
}

test("createPin: POSTs strong pin with identity headers", async () => {
  const { calls, tv } = stub({ "/api/v2/pins": { id: 42, code: "ABCD" } });
  assert.deepEqual(await tv.createPin(), { id: 42, code: "ABCD" });
  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url.host, "plex.tv");
  assert.equal(c.url.searchParams.get("strong"), "true");
  assert.equal(c.headers["X-Plex-Client-Identifier"], "cid-1");
  assert.equal(c.headers["X-Plex-Product"], "plex-mcp");
  assert.equal(c.headers.Accept, "application/json");
});

test("pollPin: null until the token arrives", async () => {
  let n = 0;
  const { tv } = stub({ "/api/v2/pins/42": () => ({ id: 42, authToken: ++n > 1 ? "tok" : null }) });
  assert.equal(await tv.pollPin(42), null);
  assert.equal(await tv.pollPin(42), "tok");
});

test("authUrl: carries clientID, code, and product context", () => {
  const { tv } = stub({});
  const u = tv.authUrl("ABCD");
  assert.match(u, /^https:\/\/app\.plex\.tv\/auth#\?/);
  assert.match(u, /clientID=cid-1/);
  assert.match(u, /code=ABCD/);
  assert.match(u, /context%5Bdevice%5D%5Bproduct%5D=plex-mcp/);
});

test("resources: only servers, with connections flagged local/remote, token sent as header", async () => {
  const { calls, tv } = stub({
    "/api/v2/resources": [
      { name: "NAS", provides: "server", clientIdentifier: "m1", owned: true,
        connections: [{ uri: "http://192.0.2.5:32400", local: true }, { uri: "https://1-2-3-4.plex.direct:32400", local: false }] },
      { name: "Phone", provides: "player,controller", clientIdentifier: "m2", connections: [] },
    ],
  });
  const r = await tv.resources("tok");
  assert.deepEqual(r, [{ name: "NAS", clientIdentifier: "m1", owned: true,
    connections: [{ uri: "http://192.0.2.5:32400", local: true }, { uri: "https://1-2-3-4.plex.direct:32400", local: false }] }]);
  assert.equal(calls[0].headers["X-Plex-Token"], "tok");
  assert.equal(calls[0].url.searchParams.get("includeHttps"), "1");
});

test("homeUsers + switchHomeUser: switches by the uuid homeUsers returned", async () => {
  const { calls, tv } = stub({
    "/api/v2/home/users": { users: [
      { id: 1, uuid: "aa11", title: "Owner", admin: true, restricted: false },
      { id: 7, uuid: "bb22", title: "Kid", admin: false, restricted: true, protected: false },
      { id: 9, title: "No uuid" },
    ] },
    "/api/v2/home/users/bb22/switch": { authToken: "kidtok" },
  });
  const users = await tv.homeUsers("tok");
  assert.deepEqual(users, [
    { id: 1, uuid: "aa11", title: "Owner", admin: true, restricted: false, protected: false },
    { id: 7, uuid: "bb22", title: "Kid", admin: false, restricted: true, protected: false },
  ]);
  assert.equal(await tv.switchHomeUser("tok", users[1].uuid), "kidtok");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url.pathname, "/api/v2/home/users/bb22/switch");
  assert.equal(calls[1].url.searchParams.get("pin"), null);
});

test("serverToken: the user's access token for the server with that machine id", async () => {
  const { calls, tv } = stub({
    "/api/v2/resources": [
      { name: "Other", provides: "server", clientIdentifier: "m2", accessToken: "other-tok", connections: [] },
      { name: "NAS", provides: "server", clientIdentifier: "m1", accessToken: "nas-tok", connections: [] },
    ],
  });
  assert.equal(await tv.serverToken("usertok", "m1"), "nas-tok");
  assert.equal(calls[0].headers["X-Plex-Token"], "usertok");
  assert.equal(calls[0].url.searchParams.get("includeHttps"), "1");
  assert.equal(await tv.serverToken("usertok", "m3"), null);
});

test("errors carry status and path only", async () => {
  const { tv } = stub({});
  await assert.rejects(tv.createPin(), (e: Error) => e.message === "plex.tv 404 on /api/v2/pins");
  await assert.rejects(tv.createPin(), (e: Error) => e instanceof UpstreamError && e.status === 404);
});

test("a refused connection names plex.tv, the cause's code and the path", async () => {
  const fetchImpl = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(makePlexTv({ fetchImpl }).createPin(), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^plex\.tv unreachable \(ECONNREFUSED\) on \/api\/v2\/pins$/);
    return true;
  });
});

test("a timeout names plex.tv, the 30 seconds and the path", async () => {
  const fetchImpl = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  await assert.rejects(makePlexTv({ fetchImpl }).createPin(), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^plex\.tv timed out after 30s on \/api\/v2\/pins$/);
    return true;
  });
});

test("a 2xx body that is not JSON throws naming the path, without echoing the body", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>/srv/app/secret/path</html>" });
  const tv = makePlexTv({ fetchImpl });
  await assert.rejects(tv.createPin(), (e: Error) => e.message === "plex.tv returned a reply that is not JSON on /api/v2/pins");
});

test("watchlist: newest first from the Discover host, paged by container headers", async () => {
  const { calls, tv } = stub({
    "/library/sections/watchlist/all": { MediaContainer: { totalSize: 3, size: 2, Metadata: [
      { guid: "plex://movie/5d776825", ratingKey: "5d776825", type: "movie", title: "Arrival", year: 2016 },
      { guid: "plex://show/5d9c0868", ratingKey: "5d9c0868", type: "show", title: "Severance" },
      { title: "No guid", type: "movie" },
    ] } },
  });
  assert.deepEqual(await tv.watchlist("tok", { start: 10, size: 2 }), { totalSize: 3, size: 3, items: [
    { guid: "plex://movie/5d776825", title: "Arrival", type: "movie", year: 2016 },
    { guid: "plex://show/5d9c0868", title: "Severance", type: "show" },
  ] });
  assert.equal(calls[0].url.host, "discover.provider.plex.tv");
  assert.equal(calls[0].headers["X-Plex-Token"], "tok");
  assert.equal(calls[0].headers["X-Plex-Container-Start"], "10");
  assert.equal(calls[0].headers["X-Plex-Container-Size"], "2");
  assert.equal(calls[0].url.searchParams.get("sort"), "watchlistedAt:desc");
});

test("editWatchlist: PUTs the id from the end of the Plex GUID", async () => {
  const { calls, tv } = stub({ "/actions/addToWatchlist": { MediaContainer: { size: 0 } }, "/actions/removeFromWatchlist": { MediaContainer: { size: 0 } } });
  await tv.editWatchlist("tok", "add", "plex://movie/5d776825");
  await tv.editWatchlist("tok", "remove", "plex://show/5d9c0868");
  assert.deepEqual(calls.map((c) => [c.method, c.url.host, c.url.pathname, c.url.searchParams.get("ratingKey"), c.headers["X-Plex-Token"]]), [
    ["PUT", "discover.provider.plex.tv", "/actions/addToWatchlist", "5d776825", "tok"],
    ["PUT", "discover.provider.plex.tv", "/actions/removeFromWatchlist", "5d9c0868", "tok"],
  ]);
  await assert.rejects(tv.editWatchlist("tok", "add", "com.plexapp.agents.imdb://tt2543164"), /is not a Plex GUID/);
  assert.equal(calls.length, 2);
});

test("installClientId: stable for one hostname and user, different when either changes", () => {
  const user = (username: string) => () => ({ username });
  const id = installClientId({ hostname: () => "nas", userInfo: user("alice") });
  assert.match(id, /^plex-mcp-[0-9a-f]{16}$/);
  assert.equal(installClientId({ hostname: () => "nas", userInfo: user("alice") }), id);
  assert.notEqual(installClientId({ hostname: () => "laptop", userInfo: user("alice") }), id);
  assert.notEqual(installClientId({ hostname: () => "nas", userInfo: user("node") }), id);
  assert.ok(!id.includes("nas") && !id.includes("alice"));
});

test("installClientId: a uid with no passwd entry still gets an identifier", () => {
  const userInfo = () => { throw new Error("ENOENT: no such file or directory, uv_os_get_passwd"); };
  assert.match(installClientId({ hostname: () => "nas", userInfo }), /^plex-mcp-[0-9a-f]{16}$/);
});

test("makePlexTv with no clientId sends this install's identifier", async () => {
  const calls: Array<Record<string, string>> = [];
  const fetchImpl = async (_url: URL, init: RequestInit = {}) => {
    calls.push(init.headers as Record<string, string>);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 1, code: "c" }) };
  };
  const tv = makePlexTv({ fetchImpl });
  await tv.createPin();
  assert.equal(calls[0]!["X-Plex-Client-Identifier"], installClientId());
  assert.equal(tv.clientId, installClientId());
  assert.match(tv.authUrl("c"), /clientID=plex-mcp-[0-9a-f]{16}&/);
});
