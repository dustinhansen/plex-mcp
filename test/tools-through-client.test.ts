// Tools fed raw Plex JSON through the real client. Most tool tests fake the
// client above its parsers, so a field the parsers drop never reaches them;
// these bodies are Plex-shaped so a dropped field fails here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { readTools } from "#dist/lib/tools-read.js";
import { historyTools } from "#dist/lib/tools-history.js";
import { discoverTools } from "#dist/lib/tools-discover.js";
import { writeTools } from "#dist/lib/tools-write.js";
import { makePlexTv } from "#dist/lib/plextv.js";
import { buildServer, buildTools } from "#dist/lib/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRecord } from "#dist/lib/format.js";

type Call = { method: string; host: string; path: string; query: Record<string, string>; headers: Record<string, string> };

/** Plex-shaped responses keyed by "METHOD pathname"; GET may omit the method.
 *  plex.tv routes answer for the Discover host, through the real plex.tv client. */
function plexServer(routes: Record<string, unknown>, plexTvRoutes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: URL, opts: RequestInit = {}) => {
    const u = new URL(url);
    const method = opts.method ?? "GET";
    calls.push({ method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: opts.headers as Record<string, string> });
    const table = u.host === "discover.provider.plex.tv" ? plexTvRoutes : routes;
    const hit = table[`${method} ${u.pathname}`] ?? (method === "GET" ? table[u.pathname] : undefined);
    if (hit === undefined) return { ok: false, status: 404, text: async () => "" };
    const body = typeof hit === "function" ? (hit as (u: URL, opts: RequestInit) => unknown)(u, opts) : hit;
    if (body === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => (body === "" ? "" : JSON.stringify({ MediaContainer: body })) };
  };
  return { calls, client: makeClient({ baseUrl: "http://plex.test:32400", token: "tok", fetchImpl, plextv: makePlexTv({ fetchImpl }) }) };
}

/** One tools/call through the MCP server, the way a client sends it. */
async function callTool(client: ReturnType<typeof plexServer>["client"], name: string, args: Record<string, unknown>) {
  const { server } = buildServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "tools-through-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = await mcp.callTool({ name, arguments: args });
    return { isError: result.isError, text: (result.content as TextContent[])[0]!.text };
  } finally {
    await mcp.close();
    await server.close();
  }
}

const SECTIONS = {
  size: 2,
  Directory: [
    { key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", refreshing: false },
    { key: "2", title: "TV Shows", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series", refreshing: false },
  ],
};
const ACCOUNTS = { size: 2, Account: [{ id: 1, key: "/accounts/1", name: "alice" }, { id: 7, key: "/accounts/7", name: "bob" }] };
const ARRIVAL = {
  ratingKey: "10", key: "/library/metadata/10", guid: "plex://movie/5d776", type: "movie", title: "Arrival",
  librarySectionTitle: "Movies", librarySectionID: 1, librarySectionKey: "/library/sections/1",
  year: 2016, viewCount: 1, lastViewedAt: 1700000000, addedAt: 1600000000, duration: 6960000, contentRating: "PG-13",
  Genre: [{ tag: "Science Fiction" }], Director: [{ tag: "Denis Villeneuve" }],
};
const DIRECTOR_HUB = {
  hubIdentifier: "director", title: "Directors", type: "director", size: 1,
  Directory: [{ key: "/library/sections/1/all?director=55", librarySectionTitle: "Movies", librarySectionID: 1, type: "tag", id: 55, tag: "Denis Villeneuve", tagType: 4 }],
};

// A crafted id that reached the client would be a GET Plex treats as a write:
// a scrobble, a rating, or a metadata refresh. Read-only mode registers no
// write tool, so these ids are the only way in and none of them gets sent.
test("read-only get_item and get_children refuse an id that is not a run of digits, and send nothing", async () => {
  const { calls, client } = plexServer({});
  const tools = buildTools(client, { readOnly: true });
  const ids = [
    "../../:/scrobble?key=123&identifier=com.plexapp.plugins.library",
    "../../library/sections/1/refresh?force=1",
    "../../:/rate?key=123&rating=10&identifier=com.plexapp.plugins.library",
  ];
  for (const name of ["get_item", "get_children"] as const) {
    for (const ratingKey of ids) {
      await assert.rejects(async () => tools[name].invoke({ ratingKey }), (e: { issues?: Array<{ message: string }> }) => {
        assert.match(e.issues?.[0]?.message ?? "", /run of digits/, `${name} ${ratingKey}`);
        return true;
      });
    }
  }
  assert.equal(calls.length, 0);
});

test("search: movie and director hubs both come back, item hits carry their library", async () => {
  const { client } = plexServer({
    "/hubs/search": {
      size: 3,
      Hub: [
        { hubIdentifier: "movie", title: "Movies", type: "movie", size: 1, Metadata: [ARRIVAL] },
        DIRECTOR_HUB,
        { hubIdentifier: "show", title: "Shows", type: "show", size: 0 },
      ],
    },
  });
  const out = await readTools(client).search.handler({ query: "arrival", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(Object.keys(out).sort(), ["directors", "movies"]);
  assert.deepEqual(out.directors, [{ name: "Denis Villeneuve", id: 55 }]);
  assert.equal(out.movies.length, 1);
  assert.equal(out.movies[0].title, "Arrival");
  assert.equal(out.movies[0].ratingKey, "10");
  assert.equal(out.movies[0].watched, true);
  assert.equal(out.movies[0].library, "Movies");
});

// Plex's guid= filter matches only an item's own plex:// guid, so an external
// id is matched against the Guid tags of each movie and show section.
const LOOKUP_SECTIONS = {
  size: 6,
  Directory: [
    ...SECTIONS.Directory,
    { key: "3", title: "Home Videos", type: "movie", agent: "tv.plex.agents.none", scanner: "Plex Video Files Scanner", refreshing: false },
    { key: "4", title: "Concerts", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Video Files Scanner", refreshing: false },
    { key: "6", title: "Old Home Videos", type: "movie", agent: "com.plexapp.agents.none", scanner: "Plex Movie Scanner", refreshing: false },
    { key: "5", title: "Music", type: "artist", agent: "tv.plex.agents.music", scanner: "Plex Music", refreshing: false },
  ],
};
const HEAT = {
  ratingKey: "30", key: "/library/metadata/30", guid: "plex://movie/5d7768", type: "movie", title: "Heat", year: 1995,
  librarySectionTitle: "Movies", Guid: [{ id: "imdb://tt0113277" }, { id: "tmdb://949" }, { id: "tvdb://1186" }],
};
const SEVERANCE = {
  ratingKey: "20", key: "/library/metadata/20/children", guid: "plex://show/5d9c08", type: "show", title: "Severance", year: 2022,
  librarySectionTitle: "TV Shows", leafCount: 19, viewedLeafCount: 12, Guid: [{ id: "imdb://tt11280740" }, { id: "tvdb://371980" }],
};

test("search externalId: reads each movie and show section with its Guid tags, skips personal media and music, returns every match with its library", async () => {
  const { client, calls } = plexServer({
    "/library/sections": LOOKUP_SECTIONS,
    "/library/sections/1/all": { size: 2, totalSize: 2, Metadata: [{ ...ARRIVAL, Guid: [{ id: "imdb://tt2543164" }] }, HEAT] },
    "/library/sections/2/all": { size: 1, totalSize: 1, Metadata: [SEVERANCE] },
    "/library/sections/4/all": { size: 1, totalSize: 1, Metadata: [{ ...HEAT, ratingKey: "31", librarySectionTitle: "Concerts" }] },
  });
  const out = await readTools(client).search.handler({ externalId: "imdb:tt0113277", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(Object.keys(out), ["movies"]);
  assert.deepEqual(out.movies.map((m) => [m.title, m.ratingKey, m.library]), [["Heat", "30", "Movies"], ["Heat", "31", "Concerts"]]);
  const listings = calls.filter((c) => c.path.endsWith("/all"));
  assert.deepEqual(listings.map((c) => c.path), ["/library/sections/1/all", "/library/sections/2/all", "/library/sections/4/all"]);
  assert.ok(listings.every((c) => c.query.includeGuids === "1"));
  assert.ok(!calls.some((c) => c.path === "/hubs/search"));
});

test("search externalId: tmdb and tvdb ids match too, and a show comes back under shows", async () => {
  const { client } = plexServer({
    "/library/sections": LOOKUP_SECTIONS,
    "/library/sections/1/all": { size: 1, totalSize: 1, Metadata: [HEAT] },
    "/library/sections/2/all": { size: 1, totalSize: 1, Metadata: [SEVERANCE] },
    "/library/sections/4/all": { size: 0, totalSize: 0, Metadata: [] },
  });
  const t = readTools(client);
  const byTmdb = await t.search.handler({ externalId: "tmdb:949", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(byTmdb.movies.map((m) => m.title), ["Heat"]);
  const byTvdb = await t.search.handler({ externalId: "TVDB:371980", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(Object.keys(byTvdb), ["shows"]);
  assert.deepEqual(byTvdb.shows.map((s) => [s.title, s.library]), [["Severance", "TV Shows"]]);
  assert.deepEqual(await t.search.handler({ externalId: "imdb:tt0000001", limit: 20 }), {});
  const shouted = await t.search.handler({ externalId: "IMDB:TT0113277", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(shouted.movies.map((m) => m.title), ["Heat"]);
});

test("search externalId: a legacy-agent library, whose items hold the id in their own guid, matches too", async () => {
  const { client } = plexServer({
    "/library/sections": { size: 2, Directory: [
      { key: "1", title: "Old Movies", type: "movie", agent: "com.plexapp.agents.imdb", scanner: "Plex Movie Scanner", refreshing: false },
      { key: "2", title: "Old Shows", type: "show", agent: "com.plexapp.agents.thetvdb", scanner: "Plex Series Scanner", refreshing: false },
    ] },
    "/library/sections/1/all": { size: 1, totalSize: 1, Metadata: [{ ratingKey: "30", type: "movie", title: "Heat", guid: "com.plexapp.agents.imdb://tt0113277?lang=en" }] },
    "/library/sections/2/all": { size: 1, totalSize: 1, Metadata: [{ ratingKey: "20", type: "show", title: "Severance", guid: "com.plexapp.agents.thetvdb://371980?lang=en" }] },
  });
  const t = readTools(client);
  const movie = await t.search.handler({ externalId: "imdb:tt0113277", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(movie.movies.map((m) => [m.title, m.library]), [["Heat", "Old Movies"]]);
  const show = await t.search.handler({ externalId: "tvdb:371980", limit: 20 }) as Record<string, ToolRecord[]>;
  assert.deepEqual(show.shows.map((m) => [m.title, m.library]), [["Severance", "Old Shows"]]);
});

test("search externalId: an unknown prefix names the three accepted forms and sends nothing", async () => {
  const { client, calls } = plexServer({ "/library/sections": LOOKUP_SECTIONS });
  const t = readTools(client);
  for (const externalId of ["isbn:123", "tt0113277", "imdb:", "imdb:///tt0113277"]) {
    await assert.rejects(async () => t.search.handler({ externalId, limit: 20 }), /imdb:tt0113277.*tmdb:949.*tvdb:12345/);
  }
  assert.equal(calls.length, 0);
});

test("search: neither query nor externalId, or both, is refused before anything is sent", async () => {
  const { client, calls } = plexServer({});
  const t = readTools(client);
  await assert.rejects(async () => t.search.handler({ limit: 20 }), /query or externalId/);
  await assert.rejects(async () => t.search.handler({ query: "  ", limit: 20 }), /query or externalId/);
  await assert.rejects(async () => t.search.handler({ query: "heat", externalId: "imdb:tt0113277", limit: 20 }), /not both/);
  assert.equal(calls.length, 0);
});

test("get_item: reports resolution, codecs and size from Media[].Part[]", async () => {
  const { client } = plexServer({
    "/library/metadata/10": {
      size: 1,
      Metadata: [{
        ...ARRIVAL,
        Media: [{
          id: 300, duration: 6960000, bitrate: 52000, width: 3840, height: 1600, videoResolution: "4k", videoCodec: "hevc", audioCodec: "truehd", audioChannels: 8, container: "mkv",
          Part: [{ id: 400, key: "/library/parts/400/1600000000/file.mkv", duration: 6960000, file: "/media/movies/Arrival (2016)/Arrival.mkv", size: 45_120_000_000, container: "mkv" }],
        }],
      }],
    },
  });
  const out = await readTools(client).get_item.handler({ ratingKey: "10" });
  assert.equal(out.title, "Arrival");
  assert.deepEqual(out.directors, ["Denis Villeneuve"]);
  assert.deepEqual(out.file, {
    resolution: "4k", codec: "hevc", audioCodec: "truehd", sizeGB: 45.12,
    paths: ["/media/movies/Arrival (2016)/Arrival.mkv"], versionCount: 1,
  });
});

test("get_item: a ratingKey Plex answers 404 for is named as no item", async () => {
  const { client } = plexServer({});
  await assert.rejects(async () => readTools(client).get_item.handler({ ratingKey: "999" }), { message: "No item with ratingKey 999" });
});

test("get_extras: local extras keep their paths, streaming trailers have none", async () => {
  const { client } = plexServer({
    "/library/metadata/10/extras": {
      size: 2,
      Metadata: [
        { ratingKey: "11", key: "/library/metadata/11", type: "clip", subtype: "featurette", title: "Making Of", duration: 600000, extraType: 5,
          Media: [{ id: 301, videoResolution: "1080", Part: [{ id: 401, file: "/media/movies/Arrival (2016)/Making Of-featurette.mkv", size: 900_000_000 }] }] },
        { ratingKey: "12", key: "/library/metadata/12", type: "clip", subtype: "trailer", title: "Trailer", duration: 150000, extraType: 1,
          Media: [{ id: 302, videoResolution: "1080", Part: [{ id: 402, key: "https://trailers.example/arrival.mp4" }] }] },
      ],
    },
  });
  assert.deepEqual(await readTools(client).get_extras.handler({ ratingKey: "10" }), {
    total: 2,
    extras: [
      { title: "Making Of", subtype: "featurette", ratingKey: "11", durationMin: 10, paths: ["/media/movies/Arrival (2016)/Making Of-featurette.mkv"] },
      { title: "Trailer", subtype: "trailer", ratingKey: "12", durationMin: 3, paths: [] },
    ],
  });
});

test("get_children: seasons of a show and items of a playlist", async () => {
  const { client, calls } = plexServer({
    "/library/metadata/20/children": {
      size: 2, totalSize: 2,
      Metadata: [
        { ratingKey: "21", key: "/library/metadata/21/children", parentTitle: "Severance", type: "season", title: "Season 1", index: 1, leafCount: 9, viewedLeafCount: 9 },
        { ratingKey: "22", key: "/library/metadata/22/children", parentTitle: "Severance", type: "season", title: "Season 2", index: 2, leafCount: 10, viewedLeafCount: 3 },
      ],
    },
    "/playlists/90/items": { size: 1, totalSize: 1, Metadata: [{ ...ARRIVAL, playlistItemID: 5001 }] },
  });
  const t = readTools(client);
  const seasons = await t.get_children.handler({ ratingKey: "20", playlist: false, offset: 0, limit: 100, detail: false });
  assert.equal(seasons.total, 2);
  assert.deepEqual(seasons.items.map((s) => [s.show, s.index, s.watched]), [["Severance", 1, true], ["Severance", 2, false]]);
  const items = await t.get_children.handler({ ratingKey: "90", playlist: true, offset: 0, limit: 100, detail: false });
  assert.deepEqual(items.items.map((m) => m.title), ["Arrival"]);
  assert.equal(calls.at(-1)!.headers["X-Plex-Container-Size"], "100");
});

test("person_credits: resolves the director through the search hub, then filters the section", async () => {
  const { client, calls } = plexServer({
    "/library/sections": SECTIONS,
    "/hubs/search": { size: 1, Hub: [DIRECTOR_HUB] },
    "/library/sections/1/all": { size: 1, totalSize: 1, Metadata: [ARRIVAL] },
  });
  const out = await readTools(client).person_credits.handler({
    name: "villeneuve", role: "director", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 100, detail: false,
  });
  assert.equal(out.person, "Denis Villeneuve");
  assert.deepEqual(out.items.map((m) => m.title), ["Arrival"]);
  assert.equal(calls.at(-1)!.query.director, "55");
});

test("a blank tag filter or person name is refused by parameter name, and nothing is sent", async () => {
  const { calls, client } = plexServer({});
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["list_media", { genre: "" }, "genre"],
    ["random_pick", { studio: "  " }, "studio"],
    ["person_credits", { name: "" }, "name"],
  ];
  for (const [tool, args, parameter] of cases) {
    const result = await callTool(client, tool, args);
    assert.equal(result.isError, true, tool);
    assert.match(result.text, new RegExp(`${parameter} cannot be blank`), tool);
  }
  assert.equal(calls.length, 0);
});

test("list_media: a tag filter is trimmed before it is resolved", async () => {
  const { calls, client } = plexServer({
    "/library/sections": SECTIONS,
    "/library/sections/1/genre": { size: 1, Directory: [{ key: "7", title: "Drama" }] },
    "/library/sections/1/all": { size: 1, totalSize: 1, Metadata: [ARRIVAL] },
  });
  const result = await callTool(client, "list_media", { genre: " Drama " });
  assert.equal(result.isError, undefined, result.text);
  assert.equal(calls.at(-1)!.path, "/library/sections/1/all");
  assert.equal(calls.at(-1)!.query.genre, "7");
});

test("person_credits: a writer index Plex answers 404 for is named as missing from the library", async () => {
  const { client, calls } = plexServer({ "/library/sections": SECTIONS });
  await assert.rejects(async () => readTools(client).person_credits.handler({
    name: "eric heisserer", role: "writer", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 100, detail: false,
  }), { message: 'Library "Movies" has no writer index on this Plex server.' });
  assert.equal(calls.at(-1)!.path, "/library/sections/1/writer");
});

test("library_stats: a photo section is refused by name and type before it is walked", async () => {
  const { client, calls } = plexServer({
    "/library/sections": { size: 1, Directory: [{ key: "7", title: "Family Photos", type: "photo", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner", refreshing: false }] },
  });
  await assert.rejects(async () => readTools(client).library_stats.handler({ library: "Family Photos", includeUserStats: false }), {
    message: 'library_stats does not support "Family Photos" (a Photos library). It supports Movies, TV Shows, Other Videos, and Music only.',
  });
  assert.deepEqual(calls.map((c) => c.path), ["/library/sections"]);
});

test("library_stats: counts and breakdowns from a paged section walk, plays by user", async () => {
  const { client } = plexServer({
    "/library/sections": SECTIONS,
    "/accounts": ACCOUNTS,
    "/library/sections/1/all": {
      size: 2, totalSize: 2,
      Metadata: [ARRIVAL, { ratingKey: "13", key: "/library/metadata/13", type: "movie", title: "Dune", year: 2021, contentRating: "PG-13", Genre: [{ tag: "Science Fiction" }, { tag: "Adventure" }] }],
    },
    "/status/sessions/history/all": {
      size: 3,
      Metadata: [
        { historyKey: "/status/sessions/history/1", ratingKey: "10", title: "Arrival", type: "movie", viewedAt: 1700000000, accountID: 1, deviceID: 3 },
        { historyKey: "/status/sessions/history/2", ratingKey: "10", title: "Arrival", type: "movie", viewedAt: 1700001000, accountID: 7, deviceID: 3 },
        { historyKey: "/status/sessions/history/3", ratingKey: "13", title: "Dune", type: "movie", viewedAt: 1700002000, accountID: 7, deviceID: 3 },
      ],
    },
  });
  assert.deepEqual(await readTools(client).library_stats.handler({ library: "Movies", includeUserStats: true }), {
    library: "Movies", total: 2, watched: 1, unwatched: 1,
    genres: { "Science Fiction": 2, Adventure: 1 }, decades: { "2010s": 1, "2020s": 1 }, contentRatings: { "PG-13": 2 },
    playsByUser: { bob: 2, alice: 1 },
  });
});

test("library_stats: a show counts as watched once every episode is", async () => {
  const { client, calls } = plexServer({
    "/library/sections": SECTIONS,
    "/library/sections/2/all": {
      size: 3, totalSize: 3,
      Metadata: [
        { ratingKey: "20", key: "/library/metadata/20/children", type: "show", title: "Severance", year: 2022, leafCount: 19, viewedLeafCount: 19 },
        { ratingKey: "21", key: "/library/metadata/21/children", type: "show", title: "Andor", year: 2022, leafCount: 24, viewedLeafCount: 12, viewCount: 12 },
        { ratingKey: "22", key: "/library/metadata/22/children", type: "show", title: "Pending", year: 2025, leafCount: 0, viewedLeafCount: 0 },
      ],
    },
  });
  assert.deepEqual(await readTools(client).library_stats.handler({ library: "TV Shows", includeUserStats: false }), {
    library: "TV Shows", total: 3, watched: 1, unwatched: 2, episodes: 43, episodesWatched: 31,
    genres: {}, decades: { "2020s": 3 }, contentRatings: {},
  });
  assert.equal(calls.find((c) => c.path === "/library/sections/2/all")!.query.type, "2");
});

test("watch_history: plays named by account, filtered to the user asked for", async () => {
  const { client, calls } = plexServer({
    "/accounts": ACCOUNTS,
    "/status/sessions/history/all": {
      size: 1, totalSize: 1,
      Metadata: [{ historyKey: "/status/sessions/history/9", ratingKey: "31", title: "Good News About Hell", type: "episode", grandparentTitle: "Severance", viewedAt: 1700000000, accountID: 7, deviceID: 3 }],
    },
  });
  const out = await historyTools(client).watch_history.handler({ user: "bob", offset: 0, limit: 50 });
  assert.equal(calls.find((c) => c.path === "/status/sessions/history/all")!.query.accountID, "7");
  assert.deepEqual(out, {
    total: 1, offset: 0, returned: 1,
    plays: [{ title: "Good News About Hell", kind: "episode", show: "Severance", artist: null, viewedAt: "2023-11-14T22:13:20.000Z", user: "bob", accountID: 7, ratingKey: "31" }],
  });
});

test("now_playing: user, player and progress from a session", async () => {
  const { client } = plexServer({
    "/status/sessions": {
      size: 1,
      Metadata: [{
        ...ARRIVAL, sessionKey: "1", viewOffset: 3480000,
        User: { id: "7", thumb: "https://plex.tv/users/x/avatar", title: "bob" },
        Player: { address: "192.0.2.5", machineIdentifier: "abc", product: "Plex for Apple TV", state: "playing", title: "Living Room" },
        Session: { id: "s1", bandwidth: 20000, location: "lan" },
      }],
    },
  });
  assert.deepEqual(await historyTools(client).now_playing.handler({}), {
    sessions: [{ user: "bob", title: "Arrival", kind: "movie", show: null, player: "Plex for Apple TV", state: "playing", progressPct: 50 }],
  });
});

test("continue_watching: next episodes with their library, as progress or item records", async () => {
  const episode = {
    ratingKey: "32", key: "/library/metadata/32", type: "episode", title: "Half Loop", grandparentTitle: "Severance", parentIndex: 1, index: 3,
    librarySectionTitle: "TV Shows", librarySectionID: 2, duration: 3000000, viewOffset: 600000, lastViewedAt: 1700000000,
  };
  const { client } = plexServer({ "/library/onDeck": { size: 1, Metadata: [episode] } });
  const deck = await discoverTools(client).continue_watching.handler({ limit: 20, detail: true });
  assert.deepEqual(deck.items.map((m) => [m.show, m.season, m.episode, m.title]), [["Severance", 1, 3, "Half Loop"]]);
  const cont = await discoverTools(client).continue_watching.handler({ limit: 20, detail: false });
  assert.deepEqual(cont.items.map((m) => [m.show, m.season, m.episode, m.title]), [["Severance", 1, 3, "Half Loop"]]);
  assert.equal(cont.items[0].library, "TV Shows");
  assert.equal(cont.items[0].viewOffsetMin, 10);
});

test("list_users: accounts by id and name, the unnamed owner reads as owner", async () => {
  const { client } = plexServer({ "/accounts": { size: 2, Account: [{ id: 0, key: "/accounts/0", name: "" }, { id: 7, key: "/accounts/7", name: "bob" }] } });
  assert.deepEqual(await historyTools(client).list_users.handler({}), [{ id: 0, name: "owner" }, { id: 7, name: "bob" }]);
});

test("manage_playlist remove_items: one DELETE per matched item, addressed by playlistItemID", async () => {
  const { client, calls } = plexServer({
    "/playlists/90/items": {
      size: 3, totalSize: 3,
      Metadata: [
        { ...ARRIVAL, playlistItemID: 5001 },
        { ratingKey: "13", key: "/library/metadata/13", type: "movie", title: "Dune", playlistItemID: 5002 },
        { ratingKey: "14", key: "/library/metadata/14", type: "movie", title: "Heat", playlistItemID: 5003 },
      ],
    },
    "DELETE /playlists/90/items/5001": "",
    "DELETE /playlists/90/items/5003": "",
  });
  const out = await writeTools(client).manage_playlist.handler({ action: "remove_items", playlistId: "90", mediaType: "video", ratingKeys: ["10", "14", "99"] });
  assert.deepEqual(out, { playlistId: "90", removed: 2 });
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/playlists/90/items/5001", "/playlists/90/items/5003"]);
});

test("manage_playlist remove_items: a matched item with no playlistItemID is skipped, never sent as undefined", async () => {
  const { client, calls } = plexServer({
    "/playlists/90/items": {
      size: 2, totalSize: 2,
      Metadata: [
        { ...ARRIVAL, playlistItemID: 5001 },
        { ratingKey: "13", key: "/library/metadata/13", type: "movie", title: "Dune" },
      ],
    },
    "DELETE /playlists/90/items/5001": "",
  });
  const out = await writeTools(client).manage_playlist.handler({ action: "remove_items", playlistId: "90", mediaType: "video", ratingKeys: ["10", "13"] });
  assert.deepEqual(out, { playlistId: "90", removed: 1, skipped: ["13"] });
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/playlists/90/items/5001"]);
});

const EPISODE = { ratingKey: "21", key: "/library/metadata/21", guid: "plex://episode/5d9c0870", type: "episode", title: "Good News About Hell" };
const LEGACY = { ratingKey: "22", key: "/library/metadata/22", guid: "com.plexapp.agents.imdb://tt0113277", type: "movie", title: "Heat" };

test("get_watchlist: plex.tv entries matched to library items by GUID", async () => {
  const { client, calls } = plexServer({
    "/library/all": (u: URL) => {
      const hit = [ARRIVAL, SEVERANCE].find((m) => m.guid === u.searchParams.get("guid"));
      return { size: hit ? 1 : 0, ...(hit && { Metadata: [hit] }) };
    },
  }, {
    "/library/sections/watchlist/all": { librarySectionTitle: "Watchlist", offset: 0, totalSize: 5, size: 4, Metadata: [
      { guid: "plex://movie/5d776", ratingKey: "5d776", key: "/library/metadata/5d776", type: "movie", title: "Arrival", year: 2016, userState: true },
      { guid: "plex://movie/5d999", ratingKey: "5d999", key: "/library/metadata/5d999", type: "movie", title: "Paddington 2", year: 2017 },
      { guid: "plex://show/5d9c08", ratingKey: "5d9c08", key: "/library/metadata/5d9c08", type: "show", title: "Severance", year: 2022 },
      { ratingKey: "5daaa", type: "movie", title: "No GUID" },
    ] },
  });
  const out = await discoverTools(client).get_watchlist.handler({ offset: 0, limit: 4 });
  // the entry plex.tv sent without a GUID is left out, but still moves the page on
  assert.deepEqual(out, { total: 5, offset: 0, returned: 3, nextOffset: 4, items: [
    { title: "Arrival", year: 2016, kind: "movie", inLibrary: true, ratingKey: "10" },
    { title: "Paddington 2", year: 2017, kind: "movie", inLibrary: false, ratingKey: null },
    { title: "Severance", year: 2022, kind: "show", inLibrary: true, ratingKey: "20" },
  ] });
  const page = calls.find((c) => c.host === "discover.provider.plex.tv")!;
  assert.equal(page.headers["X-Plex-Container-Start"], "0");
  assert.equal(page.headers["X-Plex-Container-Size"], "4");
  assert.deepEqual(calls.filter((c) => c.path === "/library/all").map((c) => c.query.guid), ["plex://movie/5d776", "plex://movie/5d999", "plex://show/5d9c08"]);
});

test("manage_watchlist: one plex.tv PUT per resolved GUID, for add and for remove", async () => {
  for (const action of ["add", "remove"] as const) {
    const { client, calls } = plexServer(
      { "/library/metadata/10,20": { size: 2, Metadata: [ARRIVAL, SEVERANCE] } },
      { "PUT /actions/addToWatchlist": { size: 0 }, "PUT /actions/removeFromWatchlist": { size: 0 } },
    );
    const out = await writeTools(client).manage_watchlist.handler({ action, ratingKeys: ["10", "20"] });
    assert.deepEqual(out, { action, items: [{ ratingKey: "10", title: "Arrival" }, { ratingKey: "20", title: "Severance" }] });
    const sent = calls.filter((c) => c.host === "discover.provider.plex.tv");
    const path = action === "add" ? "/actions/addToWatchlist" : "/actions/removeFromWatchlist";
    assert.deepEqual(sent.map((c) => [c.method, c.path, c.query.ratingKey]), [["PUT", path, "5d776"], ["PUT", path, "5d9c08"]]);
  }
});

test("manage_watchlist: a key the server lacks fails the call by name and sends nothing to plex.tv", async () => {
  const { client, calls } = plexServer({ "/library/metadata/10,99": { size: 1, Metadata: [ARRIVAL] } }, { "PUT /actions/addToWatchlist": { size: 0 } });
  await assert.rejects(async () => writeTools(client).manage_watchlist.handler({ action: "add", ratingKeys: ["10", "99"] }), (e: Error) => e.message === "Not in any library: 99");
  // every key unknown: the server 404s instead of answering with an empty list
  await assert.rejects(async () => writeTools(client).manage_watchlist.handler({ action: "remove", ratingKeys: ["98", "99"] }), (e: Error) => e.message === "Not in any library: 98, 99");
  assert.equal(calls.filter((c) => c.host === "discover.provider.plex.tv").length, 0);
});

test("manage_watchlist: an episode or an item without a Plex GUID is refused before anything is sent", async () => {
  const { client, calls } = plexServer({
    "/library/metadata/10,21": { size: 2, Metadata: [ARRIVAL, EPISODE] },
    "/library/metadata/10,22": { size: 2, Metadata: [ARRIVAL, LEGACY] },
  }, { "PUT /actions/addToWatchlist": { size: 0 } });
  await assert.rejects(async () => writeTools(client).manage_watchlist.handler({ action: "add", ratingKeys: ["10", "21"] }), /movies and shows only: 21$/);
  await assert.rejects(async () => writeTools(client).manage_watchlist.handler({ action: "add", ratingKeys: ["10", "22"] }), /No Plex GUID, so plex.tv can't identify: 22$/);
  assert.equal(calls.filter((c) => c.host === "discover.provider.plex.tv").length, 0);
});

test("manage_watchlist: a plex.tv failure partway names the keys already changed", async () => {
  let puts = 0;
  const { client } = plexServer(
    { "/library/metadata/10,20": { size: 2, Metadata: [ARRIVAL, SEVERANCE] } },
    { "PUT /actions/addToWatchlist": () => (++puts === 1 ? { size: 0 } : undefined) },
  );
  await assert.rejects(async () => writeTools(client).manage_watchlist.handler({ action: "add", ratingKeys: ["10", "20"] }),
    (e: Error) => e.message === "plex.tv 404 on /actions/addToWatchlist. Already added: 10.");
});
