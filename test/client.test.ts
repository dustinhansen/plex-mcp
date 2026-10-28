import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { UpstreamError } from "#dist/lib/upstream.js";
import type { PlexTvClient } from "#dist/types/boundaries.js";

type StubInit = RequestInit & { headers: Record<string, string> };
type Route = string | object | ((u: URL, opts: StubInit) => unknown);

/** Stub fetch recording calls; responds from a route table keyed by pathname. */
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; opts: StubInit }> = [];
  const fn = async (url: URL | string, opts?: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, opts: opts as StubInit });
    const hit = routes[u.pathname];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "not found" };
    const body = typeof hit === "function" ? hit(u, opts as StubInit) : hit;
    return { ok: true, status: 200, text: async () => (body === "" ? "" : JSON.stringify({ MediaContainer: body })) };
  };
  fn.calls = calls;
  return fn;
}

const BASE = { baseUrl: "http://plex.test:32400", token: "tok" };

test("plex: sends token+accept headers, paging headers only when size given", async () => {
  const f = stubFetch({ "/library/sections": { Directory: [] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await c.plex("/library/sections");
  let h = f.calls[0].opts.headers;
  assert.equal(h["X-Plex-Token"], "tok");
  assert.equal(h.Accept, "application/json");
  assert.equal(h["X-Plex-Container-Size"], undefined);

  await c.plex("/library/sections", {}, { start: 10, size: 5 });
  h = f.calls[1].opts.headers;
  assert.equal(h["X-Plex-Container-Start"], "10");
  assert.equal(h["X-Plex-Container-Size"], "5");
});

test("plex: params land in query string, operator names survive", async () => {
  const f = stubFetch({ "/library/sections/2/all": { Metadata: [] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await c.plex("/library/sections/2/all", { type: 1, "viewCount>>": "0" });
  const u = f.calls[0].url;
  assert.equal(u.searchParams.get("type"), "1");
  assert.equal(u.searchParams.get("viewCount>>"), "0");
});

test("plex: a path that does not resolve to itself is refused before any request", async () => {
  // Plex writes over GET, so an id carrying `..` or `?` could turn a read into a scrobble.
  const f = stubFetch({ "/library/metadata/7,8": { Metadata: [] }, "/plex/library/metadata/7": { Metadata: [] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  for (const path of ["/library/metadata/../../:/scrobble?key=1", "/library/metadata/7?x=1", "/library/metadata/7#x", "/library/metadata/%2e%2e/7", "/library/metadata\\7"]) {
    await assert.rejects(c.plex(path), /does not resolve to itself/, path);
  }
  assert.equal(f.calls.length, 0);
  await c.plex("/library/metadata/7,8");
  await makeClient({ ...BASE, baseUrl: "http://plex.test/plex/", fetchImpl: f }).plex("/library/metadata/7");
  assert.deepEqual(f.calls.map((call) => call.url.pathname), ["/library/metadata/7,8", "/plex/library/metadata/7"]);
});

test("plex: non-OK throws with status and path, without echoing the body", async () => {
  // these messages reach the MCP client — Plex error bodies can carry
  // server-side paths and config, so they must not be forwarded
  const f = async () => ({ ok: false, status: 400, text: async () => "<html>/srv/app/secret/path</html>" });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await assert.rejects(c.plex("/library/whatever"), (e: Error) => {
    assert.match(e.message, /Plex 400 on \/library\/whatever/);
    assert.doesNotMatch(e.message, /srv\/app|secret|html/);
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, 400);
    return true;
  });
});

test("plex: a refused connection names Plex, the cause's code and the path", async () => {
  const f = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(makeClient({ ...BASE, fetchImpl: f }).plex("/library/sections", { q: "x" }), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^Plex unreachable \(ECONNREFUSED\) on \/library\/sections$/);
    return true;
  });
});

test("plex: a timeout while reading the body names Plex and the path", async () => {
  const f = async () => ({ ok: true, status: 200, text: async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } });
  await assert.rejects(makeClient({ ...BASE, fetchImpl: f }).plex("/library/sections"), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.message, "Plex timed out after 30s on /library/sections");
    return true;
  });
});

test("plex: a timeout names Plex, the 30 seconds and the path", async () => {
  const f = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  await assert.rejects(makeClient({ ...BASE, fetchImpl: f }).plex("/library/sections"), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, null);
    assert.match(e.message, /^Plex timed out after 30s on \/library\/sections$/);
    return true;
  });
});

test("plex: a 2xx body that is not JSON throws naming the path, without echoing the body", async () => {
  const f = async () => ({ ok: true, status: 200, text: async () => "<html>/srv/app/secret/path</html>" });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await assert.rejects(c.plex("/library/whatever"), (e: Error) => {
    assert.equal(e.message, "Plex returned a reply that is not JSON on /library/whatever");
    return true;
  });
});

test("plex: empty body (writes) → {}", async () => {
  const f = stubFetch({ "/:/scrobble": "" });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.deepEqual(await c.plex("/:/scrobble", { key: "1" }), {});
});

test("plexAll pages until short page", async () => {
  const f = stubFetch({
    "/big": (u: URL, opts: StubInit) => {
      const start = Number(opts.headers["X-Plex-Container-Start"]);
      const page = start === 0 ? Array.from({ length: 500 }, (_, i) => ({ title: String(i), type: "movie" })) : [{ title: "500", type: "movie" }];
      return { Metadata: page };
    },
  });
  const c = makeClient({ ...BASE, fetchImpl: f });
  const all = await c.plexAll("/big");
  assert.equal(all.length, 501);
  assert.equal(f.calls.length, 2);
});

test("plexAll refuses to page past maxPages when every page comes back full", async () => {
  // A server that ignores the container headers answers every page in full.
  const f = stubFetch({ "/big": { Metadata: [{ title: "a", type: "movie" }, { title: "b", type: "movie" }] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await assert.rejects(c.plexAll("/big", {}, { pageSize: 2, maxPages: 3 }), /Refusing to page past 6 items on \/big/);
  assert.equal(f.calls.length, 3);
});

test("sectionByTitle: case-insensitive, caches, helpful error", async () => {
  const f = stubFetch({ "/library/sections": { Directory: [{ title: "Movies", key: "2", type: "movie" }] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.equal((await c.sectionByTitle("movies")).key, "2");
  await c.sectionByTitle("MOVIES");
  assert.equal(f.calls.length, 1); // cached
  await assert.rejects(c.sectionByTitle("Anime"), /No library "Anime".*Movies/s);
});

test("sectionByTitle: a miss reads the section list again once, and finds a library added since", async () => {
  let lists = 0;
  const f = stubFetch({ "/library/sections": () => ({ Directory: lists++ === 0 ? [{ title: "Movies", key: "2" }] : [{ title: "Movies", key: "2" }, { title: "Anime", key: "5" }] }) });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.equal((await c.sectionByTitle("Anime")).key, "5");
  assert.equal(f.calls.length, 2);
});

test("sectionByTitle: a second miss fails listing the libraries from the fresh read", async () => {
  let lists = 0;
  const f = stubFetch({ "/library/sections": () => ({ Directory: lists++ === 0 ? [{ title: "Movies", key: "2" }] : [{ title: "Films", key: "2" }] }) });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await assert.rejects(c.sectionByTitle("Anime"), (e: Error) => {
    assert.match(e.message, /^No library "Anime"\. Available: Films$/);
    return true;
  });
  assert.equal(f.calls.length, 2);
});

test("accounts: id 0 becomes owner; accountByName matches name or id", async () => {
  const f = stubFetch({ "/accounts": { Account: [{ id: 0, name: "" }, { id: 4242, name: "alice" }] } });
  const c = makeClient({ ...BASE, fetchImpl: f });
  const accts = await c.accounts();
  assert.deepEqual(accts[0], { id: 0, name: "owner" });
  assert.equal((await c.accountByName("Alice")).id, 4242);
  assert.equal((await c.accountByName("4242")).id, 4242);
  await assert.rejects(c.accountByName("nobody"), /No user "nobody".*alice/s);
});

test("accountByName: a miss reads the account list again once, and finds an account added since", async () => {
  let lists = 0;
  const f = stubFetch({ "/accounts": () => ({ Account: lists++ === 0 ? [{ id: 0, name: "" }] : [{ id: 0, name: "" }, { id: 4242, name: "alice" }] }) });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.equal((await c.accountByName("alice")).id, 4242);
  assert.equal(f.calls.length, 2);
});

test("accountByName: a second miss fails listing the accounts from the fresh read", async () => {
  let lists = 0;
  const f = stubFetch({ "/accounts": () => ({ Account: lists++ === 0 ? [{ id: 0, name: "" }] : [{ id: 0, name: "" }, { id: 4242, name: "alice" }] }) });
  const c = makeClient({ ...BASE, fetchImpl: f });
  await assert.rejects(c.accountByName("bob"), (e: Error) => {
    assert.match(e.message, /^No user "bob"\. Available: owner, alice$/);
    return true;
  });
  assert.equal(f.calls.length, 2);
});

test("as(user): the Home-user list is cached, and a miss reads it again once before failing", async () => {
  let lists = 0;
  const plextv = {
    homeUsers: async () => { lists++; return [{ id: 7, uuid: "bb22", title: "Kid" }]; },
    switchHomeUser: async (_t: string, uuid: string) => `tok-${uuid}`,
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  await c.as("kid");
  await c.as("kid");
  assert.equal(lists, 1);
  await assert.rejects(c.as("grandma"), /^Error: No Plex Home user "grandma"\. Home users: Kid\./);
  assert.equal(lists, 2);
});

test("as(user): a Home user added since the list was cached is found on the re-read", async () => {
  let lists = 0;
  const plextv = {
    homeUsers: async () => lists++ === 0
      ? [{ id: 7, uuid: "bb22", title: "Kid" }]
      : [{ id: 7, uuid: "bb22", title: "Kid" }, { id: 9, uuid: "cc33", title: "Teen" }],
    switchHomeUser: async (_t: string, uuid: string) => `tok-${uuid}`,
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const f = stubFetch({ "/identity": { machineIdentifier: "m1" }, "/library/sections": { Directory: [] } });
  const c = makeClient({ ...BASE, fetchImpl: f, plextv });
  await c.as("kid");
  const teen = await c.as("teen");
  await teen.plex("/library/sections");
  assert.equal(f.calls.at(-1)!.opts.headers["X-Plex-Token"], "tok-cc33@m1");
  assert.equal(lists, 2);
});

test("as(user): a refusal from a stale cached entry makes the next call read the list again", async () => {
  let lists = 0;
  const plextv = {
    homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid", protected: lists++ === 0 }],
    switchHomeUser: async (_t: string, uuid: string) => `tok-${uuid}`,
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  await assert.rejects(c.as("kid"), /"Kid" is PIN-protected/);
  await c.as("kid");
  assert.equal(lists, 2);
});

test("as(user): a failed switch makes the next call read the list again", async () => {
  let lists = 0;
  const plextv = {
    homeUsers: async () => (lists++ === 0 ? [{ id: 7, uuid: "bb22", title: "Kid" }] : []),
    switchHomeUser: async () => { throw new Error("plex.tv returned 404"); },
    serverToken: async () => "y",
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  await assert.rejects(c.as("kid"), /plex\.tv returned 404/);
  await assert.rejects(c.as("kid"), /No Plex Home user "kid"\. Home users: none\./);
  assert.equal(lists, 3);
});

test("resolveSectionTag: exact ci then substring; error lists near matches", async () => {
  const f = stubFetch({
    "/library/sections/2/genre": { Directory: [{ key: "7", title: "Action" }, { key: "9", title: "Action/Adventure" }] },
  });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.deepEqual(await c.resolveSectionTag("2", "genre", "action"), { id: "7", name: "Action" });
  assert.deepEqual(await c.resolveSectionTag("2", "genre", "adven"), { id: "9", name: "Action/Adventure" });
  await assert.rejects(c.resolveSectionTag("2", "genre", "romcom"), /No genre "romcom"/);
});

test("resolvePerson: picks hub by role, dedupes, exact match wins", async () => {
  const f = stubFetch({
    "/hubs/search": {
      Hub: [
        { type: "actor", Directory: [{ id: 1002, tag: "Steven Spielberg" }, { id: 1002, tag: "Steven Spielberg" }, { id: 1003, tag: "Sasha Spielberg" }] },
        { type: "director", Directory: [{ id: 1001, tag: "Steven Spielberg" }] },
      ],
    },
  });
  const c = makeClient({ ...BASE, fetchImpl: f });
  assert.deepEqual(await c.resolvePerson("steven spielberg", "director"), { id: 1001, name: "Steven Spielberg" });
  assert.equal((await c.resolvePerson("Sasha Spielberg", "actor")).id, 1003);
  assert.deepEqual(await c.resolvePerson("spielberg", "director"), { id: 1001, name: "Steven Spielberg" });
  await assert.rejects(c.resolvePerson("kubrick", "director"), /No director "kubrick"/);
});

test("as(user): resolves a Home user by title or id, switches once, caches the token", async () => {
  const f = stubFetch({ "/library/sections": { Directory: [{ title: "Movies", key: "1" }] }, "/identity": { machineIdentifier: "m1" } });
  let switches = 0;
  const plextv = {
    homeUsers: async () => [{ id: 1, uuid: "aa11", title: "Owner", admin: true }, { id: 7, uuid: "bb22", title: "Kid", admin: false, protected: false }],
    switchHomeUser: async (_t: string, uuid: string) => { switches++; return `tok-${uuid}`; },
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: f, plextv });
  const kid = await c.as("kid");
  await kid.plex("/library/sections");
  assert.equal(f.calls.at(-1)!.opts.headers["X-Plex-Token"], "tok-bb22@m1");
  const again = await c.as("7");
  assert.equal(again, kid);
  assert.equal(switches, 1);
  assert.equal(await c.as(undefined), c);
});

test("as(user): a 401 through a Home user's client drops it, so the next as() switches again", async () => {
  let revoked = false;
  const f = async (url: URL | string, opts?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/identity") return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: { machineIdentifier: "m1" } }) };
    const token = (opts?.headers as Record<string, string>)["X-Plex-Token"];
    if (revoked && token === "tok-bb22-1@m1") return { ok: false, status: 401, text: async () => "unauthorized" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: { Directory: [] } }) };
  };
  let switches = 0;
  const plextv = {
    homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }],
    switchHomeUser: async (_t: string, uuid: string) => `tok-${uuid}-${++switches}`,
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: f, plextv });
  const kid = await c.as("kid");
  await kid.plex("/library/sections");
  revoked = true;
  await assert.rejects(kid.plex("/library/sections"), (e: Error) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, 401);
    return true;
  });
  const fresh = await c.as("kid");
  assert.notEqual(fresh, kid);
  assert.equal(switches, 2);
  await fresh.plex("/library/sections");
});

test("as(user): overlapping calls for one Home user share a single switch and client", async () => {
  let switches = 0;
  let tokens = 0;
  const plextv = {
    homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }],
    switchHomeUser: async (_t: string, uuid: string) => { switches++; return `tok-${uuid}`; },
    serverToken: async (userToken: string, machineId: string) => { tokens++; return `${userToken}@${machineId}`; },
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  const first = c.as("kid");
  const second = c.as("kid");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(switches, 1);
  assert.equal(tokens, 1);
});

test("as(user): a failed switch rejects every waiting call, and the next call switches again", async () => {
  let switches = 0;
  let fail!: (error: Error) => void;
  const plextv = {
    homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }],
    switchHomeUser: (_t: string, uuid: string) => ++switches === 1
      ? new Promise<string>((_resolve, reject) => { fail = reject; })
      : Promise.resolve(`tok-${uuid}`),
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  const first = c.as("kid");
  const second = c.as("kid");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fail, "the first call reached switchHomeUser");
  const error = new Error("plex.tv returned 503");
  fail(error);
  await assert.rejects(first, (e) => e === error);
  await assert.rejects(second, (e) => e === error);
  assert.equal(switches, 1);
  await c.as("kid");
  assert.equal(switches, 2);
});

test("as(user): unknown user lists Home users and points at watch_history", async () => {
  const plextv = { homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }], switchHomeUser: async () => "x" } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({}), plextv });
  await assert.rejects(c.as("grandma"), /No Plex Home user "grandma".*Kid.*watch_history/s);
});

test("as(user): a Home user plex.tv lists no access to this server for gets a clear error", async () => {
  const plextv = { homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }], switchHomeUser: async () => "x", serverToken: async () => null  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": { machineIdentifier: "m1" } }), plextv });
  await assert.rejects(c.as("kid"), /"Kid" has no access to this server.*watch_history/s);
});

test("as(user): a PIN-protected Home user is refused before plex.tv is asked to switch", async () => {
  let switched = false;
  const plextv = { homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid", protected: true }], switchHomeUser: async () => { switched = true; return "x"; }, serverToken: async () => "y" } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({}), plextv });
  await assert.rejects(c.as("kid"), /"Kid" is PIN-protected.*watch_history/s);
  assert.equal(switched, false);
});

test("as(user): a server with no machine identifier fails before switching", async () => {
  let switched = false;
  const plextv = { homeUsers: async () => [{ id: 7, uuid: "bb22", title: "Kid" }], switchHomeUser: async () => { switched = true; return "x"; }, serverToken: async () => "y"  } as Partial<PlexTvClient> as PlexTvClient;
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({ "/identity": {} }), plextv });
  await assert.rejects(c.as("kid"), /machine identifier/);
  assert.equal(switched, false);
});

test("as(user): without plex.tv access the error says so", async () => {
  const c = makeClient({ ...BASE, fetchImpl: stubFetch({}) });
  await assert.rejects(c.as("kid"), /plex\.tv/);
});
