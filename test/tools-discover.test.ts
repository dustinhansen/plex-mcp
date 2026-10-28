import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { discoverTools } from "#dist/lib/tools-discover.js";
import { UpstreamError } from "#dist/lib/upstream.js";
import type { ToolRecord } from "#dist/lib/format.js";
import type { PlexClient, PlexMediaContainer, PlexRequestOptions, PlexTvClient, Query } from "#dist/types/boundaries.js";

type Route = PlexMediaContainer | ((params: Query, opts: PlexRequestOptions) => PlexMediaContainer);
type FakeClient = PlexClient & { calls: Array<{ path: string; params: Query; opts: PlexRequestOptions }>; asCalledWith?: string | null };
type RandomPickArgs = Parameters<ReturnType<typeof discoverTools>["random_pick"]["handler"]>[0];
type ContinueWatchingArgs = Parameters<ReturnType<typeof discoverTools>["continue_watching"]["handler"]>[0];

function fake(routes: Record<string, Route>) {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    as: async function (this: FakeClient, u?: string | null) { this.asCalledWith = u; return this; },
    sectionByTitle: async (t: string) => ({ key: "2", type: "show", title: t }),
    resolveSectionTag: async (_k: string, type: string, name: string) => ({ id: `${type}-${name}`, name }),
    plex: async (path: string, params: Query = {}, opts: PlexRequestOptions = {}) => {
      calls.push({ path, params, opts });
      const r = routes[path];
      if (!r) throw new Error(`unrouted ${path}`);
      if (typeof r === "function") return r(params, opts);
      // A sized request gets one page, as Plex sends it.
      if (opts.size === undefined || !r.Metadata) return r;
      const start = opts.start ?? 0;
      return { ...r, Metadata: r.Metadata.slice(start, start + opts.size) };
    },
  } as unknown as FakeClient;
}

const movie = (i: number, viewCount = 0) => ({ type: "movie", title: `M${i}`, ratingKey: String(i), viewCount });

test("similar_items: filters by watched state client-side", async () => {
  const c = fake({ "/library/metadata/9/similar": { Metadata: [movie(1, 2), movie(2, 0), movie(3, 0)] } });
  const t = discoverTools(c);
  const r = await t.similar_items.handler({ ratingKey: "9", watched: "unwatched", limit: 10 });
  assert.deepEqual(r.items.map((m) => m.ratingKey), ["2", "3"]);
  assert.equal(r.items[0].watched, false);
  const all = await t.similar_items.handler({ ratingKey: "9", watched: "all", limit: 2 });
  assert.equal(all.items.length, 2);
});

test("random_pick: random sort, count as page size, filters resolved like list_media", async () => {
  const c = fake({ "/library/sections/2/all": { Metadata: [movie(1), movie(2)] } });
  const t = discoverTools(c);
  const r = await t.random_pick.handler({ library: "Movies", count: 2, kind: "movie", watched: "unwatched", genre: "Horror", rated: "all" } as RandomPickArgs);
  const call = c.calls[0];
  assert.equal(call.params.sort, "random");
  assert.equal(call.params.unwatched, "1");
  assert.equal(call.params.genre, "genre-Horror");
  assert.deepEqual(call.opts, { start: 0, size: 2 });
  assert.equal(r.picks.length, 2);
});

test("random_pick: studio filters by the studio's name, other tag filters by tag id", async () => {
  // Plex's /studio listing keys each studio by its name URL-encoded twice
  const tags: Record<string, { id: string; name: string }> = {
    studio: { id: "1440%2520Productions", name: "1440 Productions" },
    country: { id: "130338", name: "Australia" },
  };
  const c = {
    ...fake({ "/library/sections/2/all": { Metadata: [movie(1)] } }),
    resolveSectionTag: async (_k: string, type: string) => tags[type],
  } as unknown as FakeClient;
  await discoverTools(c).random_pick.handler({ library: "Movies", count: 1, kind: "movie", watched: "all", rated: "all", studio: "1440 productions", country: "australia" } as RandomPickArgs);
  const { params } = c.calls[0];
  assert.equal(params.studio, "1440 Productions");
  assert.equal(params.country, "130338");
});

test("random_pick: passes lastViewedBefore/After through as list_media does", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T12:00:00Z") });
  const c = fake({ "/library/sections/2/all": { Metadata: [movie(1, 3)] } });
  const tools = discoverTools(c);
  await tools.random_pick.handler({ library: "Movies", count: 1, kind: "movie", watched: "watched", rated: "all", lastViewedBefore: "-3y", lastViewedAfter: "2015-01-01" } as RandomPickArgs);
  const { params } = c.calls[0];
  assert.equal(params["lastViewedAt<<"], String(Date.parse("2023-10-16T12:00:00Z") / 1000));
  assert.equal(params["lastViewedAt>>"], String(Date.parse("2015-01-01") / 1000));
  assert.equal(params.sort, "random");
});

const ep = { type: "episode", title: "Pilot", ratingKey: "50", grandparentTitle: "Severance", parentIndex: 1, index: 2,
  viewOffset: 600000, lastViewedAt: 1700000000, librarySectionTitle: "TV Shows", duration: 3000000 };

test("continue_watching: section onDeck when library given, global otherwise; viewOffset in minutes", async () => {
  const c = fake({ "/library/sections/2/onDeck": { Metadata: [ep] }, "/library/onDeck": { Metadata: [ep, { ...ep, viewOffset: undefined }] } });
  const t = discoverTools(c);
  const r = await t.continue_watching.handler({ library: "TV Shows", limit: 20, user: "kid", detail: false });
  assert.equal(c.asCalledWith, "kid");
  assert.equal(c.calls[0].path, "/library/sections/2/onDeck");
  assert.deepEqual(r.items[0], {
    show: "Severance", season: 1, episode: 2, title: "Pilot", ratingKey: "50",
    viewOffsetMin: 10, durationMin: 50, lastViewedAt: "2023-11-14T22:13:20.000Z", library: "TV Shows",
  });
  const g = await t.continue_watching.handler({ limit: 1 } as ContinueWatchingArgs);
  assert.equal(c.calls[1].path, "/library/onDeck");
  assert.equal(g.items.length, 1);
  assert.equal(g.items[0].viewOffsetMin, 10);
});

test("continue_watching: unstarted next episode reports viewOffsetMin 0", async () => {
  const c = fake({ "/library/onDeck": { Metadata: [{ ...ep, viewOffset: undefined }] } });
  const r = await discoverTools(c).continue_watching.handler({ limit: 5 } as ContinueWatchingArgs);
  assert.equal(r.items[0].viewOffsetMin, 0);
});

test("continue_watching: a partly watched movie has no show, season or episode and reports its progress", async () => {
  const film = { type: "movie", title: "Arrival", ratingKey: "70", viewOffset: 2700000, duration: 7200000,
    lastViewedAt: 1700000000, librarySectionTitle: "Movies" };
  const c = fake({ "/library/onDeck": { Metadata: [film] } });
  const r = await discoverTools(c).continue_watching.handler({ limit: 5 } as ContinueWatchingArgs);
  assert.deepEqual(r.items[0], {
    show: null, season: null, episode: null, title: "Arrival", ratingKey: "70",
    viewOffsetMin: 45, durationMin: 120, lastViewedAt: "2023-11-14T22:13:20.000Z", library: "Movies",
  });
});

test("continue_watching: detail=true returns full item records with their collections, detail=false the progress records", async () => {
  const c = fake({ "/library/onDeck": { Metadata: [ep] }, "/library/metadata/50": { Metadata: [{ ...ep, Collection: [{ tag: "Prestige TV" }] }] } });
  const t = discoverTools(c);
  const [item] = (await t.continue_watching.handler({ limit: 20, detail: true })).items as ToolRecord[];
  assert.equal(item.kind, "episode");
  assert.equal(item.watched, false);
  assert.equal(item.viewCount, 0);
  assert.deepEqual(item.collections, ["Prestige TV"]);
  assert.equal("viewOffsetMin" in item, false);
  await t.continue_watching.handler({ limit: 100, detail: true });
  assert.equal(c.calls.filter((call) => call.path === "/library/onDeck").at(-1)!.opts.size, 25);
  const progress = await t.continue_watching.handler({ limit: 20, detail: false });
  assert.deepEqual(Object.keys(progress.items[0]), ["show", "season", "episode", "title", "ratingKey", "viewOffsetMin", "durationMin", "lastViewedAt", "library"]);
});

/** The real client over Plex-shaped responses, each call recorded with the token it carried. */
function homeServer(routes: Record<string, unknown>, isProtected = false) {
  const calls: Array<{ path: string; token: string }> = [];
  const fetchImpl = async (url: URL, opts: RequestInit = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, token: (opts.headers as Record<string, string>)["X-Plex-Token"] });
    const hit = routes[u.pathname];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: hit }) };
  };
  const plextv = {
    homeUsers: async () => [{ id: 9, uuid: "cc33", title: "Kid", admin: false, restricted: true, protected: isProtected }],
    switchHomeUser: async (_token: string, uuid: string) => `home-tok-${uuid}`,
    serverToken: async (userToken: string, machineId: string) => `${userToken}@${machineId}`,
  } as Partial<PlexTvClient> as PlexTvClient;
  return { calls, tools: discoverTools(makeClient({ baseUrl: "http://plex.test:32400", token: "owner-tok", fetchImpl, plextv })) };
}

const DECK = { size: 1, Metadata: [{ ratingKey: "51", title: "Half Loop", type: "episode", grandparentTitle: "Severance" }] };

test("continue_watching reads the owner's list when no user is given", async () => {
  const { calls, tools } = homeServer({ "/library/onDeck": DECK });
  const r = await tools.continue_watching.handler({ limit: 20 } as ContinueWatchingArgs);
  assert.equal(r.user, null);
  assert.deepEqual(r.items.map((i) => i.title), ["Half Loop"]);
  assert.equal(calls[0].token, "owner-tok");
});

test("continue_watching reads a Home user's list with that user's token", async () => {
  const { calls, tools } = homeServer({ "/library/onDeck": DECK, "/identity": { machineIdentifier: "m1" } });
  const r = await tools.continue_watching.handler({ user: "kid", limit: 20 } as ContinueWatchingArgs);
  assert.equal(r.user, "kid");
  assert.equal(calls.find((c) => c.path === "/library/onDeck")!.token, "home-tok-cc33@m1");
});

test("continue_watching names the Home users when the user is not one of them", async () => {
  const { calls, tools } = homeServer({ "/library/onDeck": DECK });
  await assert.rejects(tools.continue_watching.handler({ user: "bob", limit: 20 } as ContinueWatchingArgs) as Promise<unknown>, /No Plex Home user "bob"\. Home users: Kid\./);
  assert.equal(calls.length, 0);
});

const PICK_ROUTES = {
  "/library/sections": { Directory: [{ key: "1", type: "movie", title: "Movies" }] },
  "/library/sections/1/all": { Metadata: [movie(1)] },
  "/library/metadata/1": { Metadata: [{ ...movie(1), Collection: [{ tag: "Pair" }] }] },
  "/identity": { machineIdentifier: "m1" },
};
const pickArgs = { library: "Movies", count: 1, watched: "unwatched", rated: "all", detail: true } as RandomPickArgs;

test("random_pick lists and fetches detail as the Home user named in user", async () => {
  const { calls, tools } = homeServer(PICK_ROUTES);
  const r = await tools.random_pick.handler({ ...pickArgs, user: "kid" });
  assert.deepEqual(r.picks.map((p) => p.collections), [["Pair"]]);
  const tokenFor = (path: string) => calls.find((c) => c.path === path)!.token;
  assert.equal(tokenFor("/library/sections/1/all"), "home-tok-cc33@m1");
  assert.equal(tokenFor("/library/metadata/1"), "home-tok-cc33@m1");
});

test("random_pick lists as the owner when no user is given", async () => {
  const { calls, tools } = homeServer(PICK_ROUTES);
  await tools.random_pick.handler(pickArgs);
  assert.deepEqual(new Set(calls.map((c) => c.token)), new Set(["owner-tok"]));
});

test("random_pick refuses a PIN-protected Home user before Plex is asked", async () => {
  const { calls, tools } = homeServer(PICK_ROUTES, true);
  await assert.rejects(tools.random_pick.handler({ ...pickArgs, user: "kid" }) as Promise<unknown>, /"Kid" is PIN-protected/);
  assert.equal(calls.length, 0);
});

test("random_pick detail: collections come from the picks' full metadata, which the section listing leaves out", async () => {
  const c = fake({
    "/library/sections/2/all": { Metadata: [movie(1), movie(2)] },
    "/library/metadata/1,2": { Metadata: [{ ...movie(2), Collection: [{ tag: "Pair" }] }, { ...movie(1), Collection: [{ tag: "Pair" }, { tag: "Criterion" }] }] },
  });
  const t = discoverTools(c);
  const args = { library: "Movies", count: 2, kind: "movie", watched: "all", rated: "all", collection: "Pair" } as RandomPickArgs;
  const r = await t.random_pick.handler({ ...args, detail: true });
  assert.deepEqual(r.picks.map((p) => p.collections), [["Pair", "Criterion"], ["Pair"]]);
  assert.deepEqual(c.calls.map((x) => x.path), ["/library/sections/2/all", "/library/metadata/1,2"]);

  c.calls.length = 0;
  await t.random_pick.handler({ ...args, detail: false });
  assert.deepEqual(c.calls.map((x) => x.path), ["/library/sections/2/all"]);
});

test("random_pick detail: a 404 for the whole batch keeps the listing's collections", async () => {
  const c = fake({
    "/library/sections/2/all": { Metadata: [{ ...movie(1), Collection: [{ tag: "Pair" }] }] },
    "/library/metadata/1": () => { throw new UpstreamError("Plex", 404, "metadata lookup"); },
  });
  const args = { library: "Movies", count: 1, kind: "movie", watched: "all", rated: "all", detail: true } as RandomPickArgs;
  const r = await discoverTools(c).random_pick.handler(args);
  assert.deepEqual(r.picks.map((p) => p.collections), [["Pair"]]);
  assert.equal(c.calls.at(-1)!.path, "/library/metadata/1");

  // a plain Error that only says 404 is not a 404
  const plain = fake({
    "/library/sections/2/all": { Metadata: [{ ...movie(1), Collection: [{ tag: "Pair" }] }] },
    "/library/metadata/1": () => { throw new Error("Plex 404 on /library/metadata/1"); },
  });
  await assert.rejects(discoverTools(plain).random_pick.handler(args) as Promise<unknown>, /Plex 404/);
});
