// list_libraries, library_changes, scan_library and list_media's rated filter,
// against a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { readTools } from "#dist/lib/tools-read.js";
import { writeTools } from "#dist/lib/tools-write.js";
import type { PlexMediaContainer } from "#dist/types/boundaries.js";

type Route = PlexMediaContainer | "" | ((u: URL, opts?: RequestInit) => PlexMediaContainer);
type ListMediaArgs = Parameters<ReturnType<typeof readTools>["list_media"]["handler"]>[0];

/** Stub fetch recording calls; responds from a route table keyed by pathname. */
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; opts?: RequestInit }> = [];
  const fn = async (url: URL, opts?: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, opts });
    const hit = routes[u.pathname];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "not found" };
    const body = typeof hit === "function" ? hit(u, opts) : hit;
    return { ok: true, status: 200, text: async () => (body === "" ? "" : JSON.stringify({ MediaContainer: body })) };
  };
  fn.calls = calls;
  return fn;
}

const BASE = { baseUrl: "http://plex.test:32400", token: "tok" };
const SECTIONS = {
  Directory: [{ title: "Movies", key: "2", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", refreshing: 1 }],
};

test("list_libraries: fetches fresh each call and reports refreshing", async () => {
  const f = stubFetch({ "/library/sections": SECTIONS });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const libs = await T.list_libraries.handler({});
  assert.deepEqual(libs, [{
    title: "Movies", libraryType: "Movies", type: "movie", key: "2",
    agent: "tv.plex.agents.movie", scanner: "Plex Movie", refreshing: true,
  }]);
  await T.list_libraries.handler({});
  assert.equal(f.calls.length, 2); // no stale cache
});

test("list_libraries: separates Other Videos from Movies despite identical type", async () => {
  const f = stubFetch({
    "/library/sections": {
      Directory: [
        { title: "Movies", key: "2", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie" },
        { title: "Home Videos", key: "4", type: "movie", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner" },
        { title: "TV", key: "1", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series" },
        // personal-media *shows* are still a TV Shows library in Plex's UI
        { title: "Web Series", key: "5", type: "show", agent: "com.plexapp.agents.none", scanner: "Plex Personal Media Shows" },
        { title: "Music", key: "3", type: "artist", agent: "tv.plex.agents.music", scanner: "Plex Music" },
        { title: "Snapshots", key: "6", type: "photo", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner" },
      ],
    },
  });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const libs = await T.list_libraries.handler({});
  assert.deepEqual(
    Object.fromEntries(libs.map((l) => [l.title, l.libraryType])),
    {
      Movies: "Movies", "Home Videos": "Other Videos", TV: "TV Shows",
      "Web Series": "TV Shows", Music: "Music", Snapshots: "Photos",
    }
  );
  // raw `type` stays untouched so existing callers keep working
  assert.equal(libs.find((l) => l.title === "Home Videos")!.type, "movie");
});

test("list_libraries: unknown section type falls through instead of guessing", async () => {
  const f = stubFetch({ "/library/sections": { Directory: [{ title: "Odd", key: "9", type: "livetv" }] } });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const [lib] = await T.list_libraries.handler({});
  assert.deepEqual(lib, {
    title: "Odd", libraryType: "livetv", type: "livetv", key: "9",
    agent: null, scanner: null, refreshing: false,
  });
});

test("library_changes: exclusive added/updated queries, items carry updatedAt", async () => {
  const f = stubFetch({
    "/library/sections": SECTIONS,
    "/library/sections/2/all": (u: URL) => {
      if (u.searchParams.get("addedAt>>")) {
        assert.equal(u.searchParams.get("sort"), "addedAt:desc");
        return { totalSize: 1, Metadata: [{ title: "New Movie", type: "movie", ratingKey: "11", addedAt: 1752700000, updatedAt: 1752700000 }] };
      }
      assert.equal(u.searchParams.get("updatedAt>>"), "-7d");
      assert.equal(u.searchParams.get("addedAt<<"), "-7d");
      assert.equal(u.searchParams.get("sort"), "updatedAt:desc");
      return { totalSize: 1, Metadata: [{ title: "Old Movie", type: "movie", ratingKey: "12", addedAt: 1600000000, updatedAt: 1752710000 }] };
    },
  });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const out = await T.library_changes.handler({ library: "Movies", since: "-7d", limit: 100, detail: false });
  assert.equal(out.library, "Movies");
  assert.equal((out.added.items[0] as Record<string, unknown>).title, "New Movie");
  assert.equal((out.updated.items[0] as Record<string, unknown>).title, "Old Movie");
  assert.match(out.updated.items[0].updatedAt!, /^2025-07-1/); // epoch 1752710000 → ISO string
  assert.equal(out.added.total, 1);
});

test("scan_library: hits refresh endpoint, path only when given, library required", async () => {
  const f = stubFetch({ "/library/sections": SECTIONS, "/library/sections/2/refresh": "" });
  const T = writeTools(makeClient({ ...BASE, fetchImpl: f }));
  assert.deepEqual(await T.scan_library.handler({ library: "Movies" }), { scanning: "Movies", path: null });
  const refreshCall = f.calls.find((x) => x.url.pathname.endsWith("/refresh"));
  assert.equal(refreshCall!.url.searchParams.get("path"), null);

  await T.scan_library.handler({ library: "movies", path: "/data/movies/Heat (1995)" });
  const partial = f.calls.filter((x) => x.url.pathname.endsWith("/refresh"))[1];
  assert.equal(partial.url.searchParams.get("path"), "/data/movies/Heat (1995)");

  assert.equal(T.scan_library.inputSchema.library.isOptional(), false); // no default — scans are deliberate
  await assert.rejects(T.scan_library.handler({ library: "Anime" }) as Promise<unknown>, /No library "Anime"/);
});

test("list_media: rated filter reaches Plex as userRating param", async () => {
  const f = stubFetch({
    "/library/sections": SECTIONS,
    "/library/sections/2/all": (u: URL) => {
      if (u.searchParams.has("userRating>>")) {
        assert.equal(u.searchParams.get("userRating>>"), "0");
        return { totalSize: 1, Metadata: [{ title: "Heat", type: "movie", ratingKey: "21", userRating: 10 }] };
      }
      assert.equal(u.searchParams.get("userRating"), "-1");
      return { totalSize: 1, Metadata: [{ title: "Unseen Gem", type: "movie", ratingKey: "22" }] };
    },
  });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const D = { watched: "all", sort: "addedAt", order: "desc", offset: 0, limit: 5, detail: false };
  const rated = await T.list_media.handler({ library: "Movies", rated: "rated", ...D } as ListMediaArgs);
  assert.equal(rated.items[0].userRating, 10); // compact record carries it
  const unrated = await T.list_media.handler({ library: "Movies", rated: "unrated", ...D } as ListMediaArgs);
  assert.equal(unrated.items[0].userRating, null);
  assert.deepEqual(T.list_media.inputSchema.rated.removeDefault().options, ["all", "rated", "unrated"]);
});

test("list_media: lastViewedBefore/After reach Plex as lastViewedAt<< and >> epochs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T12:00:00Z") });
  const f = stubFetch({ "/library/sections": SECTIONS, "/library/sections/2/all": { totalSize: 0, Metadata: [] } });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  const D = { library: "Movies", watched: "watched", rated: "all", sort: "lastViewedAt", order: "asc", offset: 0, limit: 5, detail: false };
  const threeYearsAgo = String(Date.parse("2023-10-16T12:00:00Z") / 1000);
  const lastCall = () => f.calls.filter((x) => x.url.pathname === "/library/sections/2/all").at(-1)!.url.searchParams;

  await T.list_media.handler({ ...D, lastViewedBefore: "-3y" } as ListMediaArgs);
  assert.equal(lastCall().get("lastViewedAt<<"), threeYearsAgo);
  assert.equal(lastCall().has("lastViewedAt>>"), false);
  assert.equal(lastCall().get("viewCount>>"), "0"); // combines with watched

  await T.list_media.handler({ ...D, lastViewedAfter: "2024-01-01" } as ListMediaArgs);
  assert.equal(lastCall().get("lastViewedAt>>"), String(Date.parse("2024-01-01") / 1000));
  assert.equal(lastCall().has("lastViewedAt<<"), false);

  await T.list_media.handler({ ...D, lastViewedAfter: "-4y", lastViewedBefore: "-3y" } as ListMediaArgs);
  assert.equal(lastCall().get("lastViewedAt>>"), String(Date.parse("2022-10-16T12:00:00Z") / 1000));
  assert.equal(lastCall().get("lastViewedAt<<"), threeYearsAgo);

  await assert.rejects(T.list_media.handler({ ...D, lastViewedBefore: "ages ago" } as ListMediaArgs) as Promise<unknown>,
    /Bad lastViewedBefore "ages ago"\. Use ISO date/);
});

test("library_changes: bad since throws descriptive error", async () => {
  const f = stubFetch({ "/library/sections": SECTIONS });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  await assert.rejects(
    T.library_changes.handler({ library: "Movies", since: "lately", limit: 100, detail: false }) as Promise<unknown>,
    /Bad since "lately"/
  );
});

test("library_changes: kind 'collection' is refused before any request", async () => {
  const f = stubFetch({ "/library/sections": SECTIONS });
  const T = readTools(makeClient({ ...BASE, fetchImpl: f }));
  await assert.rejects(async () => T.library_changes.invoke({ library: "Movies", kind: "collection" }),
    (e: { issues?: Array<{ path: PropertyKey[] }> }) => e.issues?.[0]?.path[0] === "kind");
  assert.equal(f.calls.length, 0);
});
