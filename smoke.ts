// smoke.ts: live checks against the real Plex server. Read checks first,
// then a reversible write round-trip. Requires PLEX_URL + PLEX_TOKEN.
// PLEX_READ_ONLY=1 builds the read-only surface and skips the writes.
import assert from "node:assert/strict";
import { makeClient } from "#dist/lib/client.js";
import { cutoffEpoch, listParams } from "#dist/lib/filters.js";
import { readTools } from "#dist/lib/tools-read.js";
import { historyTools } from "#dist/lib/tools-history.js";
import { writeTools } from "#dist/lib/tools-write.js";
import { makePlexTv } from "#dist/lib/plextv.js";
import { buildTools } from "#dist/lib/server.js";
import { makeTautulli } from "#dist/lib/tautulli.js";

const client = makeClient({ baseUrl: process.env.PLEX_URL!, token: process.env.PLEX_TOKEN!, plextv: makePlexTv({ version: "smoke" }) });
const tautulli = process.env.TAUTULLI_URL && process.env.TAUTULLI_API_KEY
  ? makeTautulli({ baseUrl: process.env.TAUTULLI_URL, apiKey: process.env.TAUTULLI_API_KEY }) : null;
const readOnlyFlag = process.env.PLEX_READ_ONLY ?? "";
if (!["", "0", "1"].includes(readOnlyFlag)) throw new Error(`PLEX_READ_ONLY must be 1, 0 or empty, not "${readOnlyFlag}"`);
const readOnly = readOnlyFlag === "1";
// The assertions below are the shape checks on live responses, so the run reads
// tool results untyped rather than restating every result type.
type Live = any;
interface LiveTool { handler(args: object): Live }
const tools = buildTools(client, { readOnly, playback: process.env.PLEX_ALLOW_PLAYBACK === "1", tautulli }) as unknown as Record<string, LiveTool>;
// names read from the server stay out of the log, so its output can be shared
const NAMED = new Set(["library", "name", "user", "query", "genre", "title", "externalId", "collection", "country", "studio"]);
const run = async (name: string, args: object, check: (out: Live) => unknown): Promise<Live> => {
  const out = await tools[name].handler(args);
  await check(out);
  console.log(`ok  ${name} ${JSON.stringify(args, (key, value) => (NAMED.has(key) ? "…" : value)).slice(0, 80)}`);
  return out;
};
const pageArgs = { offset: 0, limit: 5, detail: false };

// --- reads ---
// No assertion depends on one server's size or names: library titles come
// from list_libraries, and counts are only checked against each other. The
// suite needs a Movies and a TV Shows library and some watch history.
const libs = await run("list_libraries", {}, (out) => assert.ok(out.length > 0));
assert.ok(libs.every((lib: Live) => typeof lib.refreshing === "boolean"), "refreshing flag present");
const TYPES = new Set(["Movies", "TV Shows", "Music", "Photos", "Other Videos"]);
assert.ok(libs.every((lib: Live) => TYPES.has(lib.libraryType)), "every library maps to a known Plex library type");
// a small side library of the same type never stands in for the main one
const largestLib = async (type: Live) => {
  let best;
  for (const lib of libs.filter((entry: Live) => entry.libraryType === type)) {
    const { total } = await tools.list_media.handler({ library: lib.title, watched: "all", sort: "addedAt", order: "desc", offset: 0, limit: 1, detail: false });
    if (!best || total > best.total) best = { title: lib.title, total };
  }
  return best?.title;
};
const MOVIES = await largestLib("Movies"), TV = await largestLib("TV Shows"), MUSIC = await largestLib("Music");
const OTHER = await largestLib("Other Videos");
assert.ok(MOVIES && TV, "smoke needs a Movies and a TV Shows library");

await run("library_changes", { library: MOVIES, since: "-90d", limit: 5, detail: false }, (out) => {
  assert.ok(out.added.total >= 0 && Array.isArray(out.added.items));
  assert.ok(out.updated.items.every((item: Live) => item.updatedAt !== null));
  const addedKeys = new Set(out.added.items.map((item: Live) => item.ratingKey));
  assert.ok(out.updated.items.every((item: Live) => !addedKeys.has(item.ratingKey)), "buckets exclusive");
});

const all = await run("list_media", { library: MOVIES, watched: "all", sort: "addedAt", order: "desc", ...pageArgs },
  (out) => { assert.ok(out.total >= out.items.length); assert.ok("watched" in out.items[0]); });
// "every item matches" holds for an empty page, so the watched and rated checks
// also need a match whenever the unfiltered listing, sorted by the field they
// test, shows the library has one
const firstBy = async (sort: string) => (await tools.list_media.handler({ library: MOVIES, watched: "all", sort, order: "desc", offset: 0, limit: 1, detail: false })).items[0];
const hasWatched = (await firstBy("viewCount"))?.viewCount > 0;
if (!hasWatched) console.log("skip watched filter match (no watched movie to test with)");
const watched = await run("list_media", { library: MOVIES, watched: "watched", sort: "addedAt", order: "desc", ...pageArgs }, (out) => {
  assert.ok(out.items.every((item: Live) => item.viewCount > 0));
  if (hasWatched) assert.ok(out.total > 0, "watched filter matched nothing");
});
const unwatched = await run("list_media", { library: MOVIES, watched: "unwatched", sort: "addedAt", order: "desc", ...pageArgs },
  (out) => assert.ok(out.items.every((item: Live) => item.viewCount === 0)));
assert.equal(watched.total + unwatched.total, all.total, "watched+unwatched=all");
// by title, not addedAt: a bulk import ties on addedAt and Plex may order ties differently per request
const byTitle = { library: MOVIES, watched: "all", sort: "title", order: "asc", ...pageArgs };
const page1 = await run("list_media", byTitle, () => {});
await run("list_media", { ...byTitle, offset: pageArgs.limit }, (out) => {
  const first = new Set(page1.items.map((item: Live) => item.ratingKey));
  assert.ok(out.items.every((item: Live) => !first.has(item.ratingKey)), "pages exclusive");
});

const hasRated = (await firstBy("userRating"))?.userRating > 0;
if (!hasRated) console.log("skip rated filter match (no rated movie to test with)");
const ratedMovies = await run("list_media", { library: MOVIES, watched: "all", rated: "rated", sort: "userRating", order: "desc", ...pageArgs }, (out) => {
  assert.ok(out.items.every((item: Live) => item.userRating != null && item.userRating > 0));
  if (hasRated) assert.ok(out.total > 0, "rated filter matched nothing");
});
const unratedMovies = await run("list_media", { library: MOVIES, watched: "all", rated: "unrated", sort: "addedAt", order: "desc", ...pageArgs },
  (out) => assert.ok(out.items.every((item: Live) => item.userRating === null)));
assert.equal(ratedMovies.total + unratedMovies.total, all.total, "rated+unrated=all");

// Plex returns never-watched items for lastViewedAt<<, so watched="watched" keeps
// this to items with a date to compare. Cutoffs taken just before and just after
// the query bracket the one Plex receives.
const cutoff = () => Number(cutoffEpoch("-1y", "lastViewedBefore")) * 1000;
const oldestView = await run("list_media", { library: MOVIES, watched: "watched", sort: "lastViewedAt", order: "asc", offset: 0, limit: 1, detail: false }, () => {});
const cutoffBefore = cutoff();
await run("list_media", { library: MOVIES, watched: "watched", lastViewedBefore: "-1y", sort: "lastViewedAt", order: "desc", ...pageArgs }, (out) => {
  const cutoffAfter = cutoff();
  assert.ok(out.items.every((item: Live) => item.lastViewedAt !== null && Date.parse(item.lastViewedAt) < cutoffAfter), "lastViewedBefore");
  // an empty page proves nothing, so when the server has a view older than the cutoff, it must come back
  const oldest = oldestView.items[0]?.lastViewedAt;
  if (oldest && Date.parse(oldest) < cutoffBefore) assert.ok(out.items.length > 0, "lastViewedBefore finds the oldest views");
  else console.log("skip lastViewedBefore match (no view older than the cutoff)");
});
await run("list_media", { library: MOVIES, kind: "collection", watched: "all", sort: "addedAt", order: "desc", ...pageArgs },
  (out) => assert.ok(out.total >= out.items.length && out.items.length <= pageArgs.limit));
if (MUSIC) {
  await run("list_media", { library: MUSIC, kind: "album", watched: "all", sort: "lastViewedAt", order: "desc", ...pageArgs },
    (out) => assert.ok(out.total >= out.items.length && out.items.length <= pageArgs.limit));
} else console.log("skip music (no Music library)");
await run("list_media", { library: TV, watched: "all", sort: "addedAt", order: "desc", ...pageArgs },
  (out) => assert.ok("episodesWatched" in out.items[0]));

const detail = await run("get_item", { ratingKey: all.items[0].ratingKey },
  (out) => { assert.ok("watched" in out && "directors" in out); assert.ok(Array.isArray(out.file?.paths) && out.file.paths.length > 0); });

// people and a genre come from the server's own movies, never a hard-coded name
const credited: Live[] = [];
for (const item of all.items) credited.push(item.ratingKey === detail.ratingKey ? detail : await tools.get_item.handler({ ratingKey: item.ratingKey }));
const firstTag = (field: string) => credited.find((movie) => movie[field].length)?.[field][0];
const director = firstTag("directors"), writer = firstTag("writers"), genre = firstTag("genres");
if (genre) {
  await run("list_media", { library: MOVIES, watched: "all", genre, maxDurationMin: 100, sort: "rating", order: "desc", ...pageArgs },
    async (out) => {
      assert.ok(out.total > 0, "genre filter matched nothing");
      for (const item of out.items) {
        assert.ok(item.durationMin <= 100);
        assert.ok((await tools.get_item.handler({ ratingKey: item.ratingKey })).genres.includes(genre), "genre on every result");
      }
    });
} else console.log("skip genre and duration filters (no genre on the newest movies)");

// The other filters take their values from the server too. Each result is
// checked on its full record, because a listing leaves out some tags (a
// movie's collections among them).
const checkFilter = async (filter: string, value: Live, holds: (movie: Live) => boolean, ordering = { sort: "title", order: "asc" }) => {
  if (!value) {
    console.log(`skip ${filter} filter (no ${filter} to test with)`);
    return;
  }
  await run("list_media", { library: MOVIES, watched: "all", [filter]: value, ...ordering, ...pageArgs }, async (out) => {
    assert.ok(out.total > 0, `${filter} filter matched nothing`);
    for (const item of out.items) assert.ok(holds(await tools.get_item.handler({ ratingKey: item.ratingKey })), `${filter} filter let ${item.ratingKey} through`);
  });
};
const year = credited.find((movie) => movie.year)?.year;
await checkFilter("year", year, (movie) => movie.year === year);
// oldest first, so an ignored decade would surface earlier years
const decadeStart = year && year - (year % 10);
await checkFilter("decade", year && `${decadeStart}s`, (movie) => movie.year >= decadeStart && movie.year < decadeStart + 10, { sort: "year", order: "asc" });
const contentRating = credited.find((movie) => movie.contentRating)?.contentRating;
await checkFilter("contentRating", contentRating, (movie) => movie.contentRating === contentRating);
// from the tags the filter resolves against: the newest movies are often in no
// collection, and a smart collection tags none of its items
const collection = (await client.plex(`/library/sections/${(await client.sectionByTitle(MOVIES)).key}/collection`)).Directory?.[0]?.title;
await checkFilter("collection", collection, (movie) => movie.collections.includes(collection));
if (collection) await run("list_media", { library: MOVIES, watched: "all", collection, sort: "title", order: "asc", ...pageArgs, detail: true }, async (out) => {
  for (const item of out.items) assert.deepEqual(item.collections, (await tools.get_item.handler({ ratingKey: item.ratingKey })).collections, `detail record ${item.ratingKey} names its collections`);
});
const country = firstTag("countries");
await checkFilter("country", country, (movie) => movie.countries.includes(country));
const studio = credited.find((movie) => movie.studio)?.studio;
await checkFilter("studio", studio, (movie) => movie.studio === studio);
// oldest first, so an ignored cutoff would surface items added before it
const addedSince = all.items[0].addedAt;
await checkFilter("addedSince", addedSince, (movie) => movie.addedAt >= addedSince, { sort: "addedAt", order: "asc" });
// the day of the newest view, oldest views first for the same reason
const newestView = (await tools.list_media.handler({ library: MOVIES, watched: "watched", sort: "lastViewedAt", order: "desc", offset: 0, limit: 1, detail: false })).items[0];
const viewedAfter = newestView?.lastViewedAt?.slice(0, 10);
await checkFilter("lastViewedAfter", viewedAfter, (movie) => movie.lastViewedAt !== null && movie.lastViewedAt >= viewedAfter, { sort: "lastViewedAt", order: "asc" });

// extras: shape must hold whether the movie has trailers or not. Every path is absolute
await run("get_extras", { ratingKey: all.items[0].ratingKey },
  (out) => { assert.ok(Array.isArray(out.extras)); out.extras.forEach((extra: Live) => extra.paths.forEach((path: Live) => assert.ok(path.startsWith("/")))); });

const show = await run("list_media", { library: TV, watched: "all", sort: "addedAt", order: "desc", offset: 0, limit: 1, detail: false }, (out) => assert.ok(out.items[0]));
const seasons = await run("get_children", { ratingKey: show.items[0].ratingKey, playlist: false, ...pageArgs },
  (out) => assert.ok(out.items.length > 0));

if (director) {
  await run("search", { query: director, limit: 10 },
    (out) => assert.ok(out.directors?.some((person: Live) => person.name === director)));
  await run("person_credits", { name: director, role: "director", library: MOVIES, watched: "all", sort: "year", order: "asc", ...pageArgs },
    (out) => { assert.equal(out.person, director); assert.ok(out.total > 0); });
} else console.log("skip director search (no director on the newest movies)");
// an IMDb id read off one of the server's own movies finds that movie again
const imdb = (await client.plex(`/library/metadata/${detail.ratingKey}`, { includeGuids: 1 })).Metadata?.[0]?.Guid?.find((guid) => guid.id.startsWith("imdb://"))?.id;
if (imdb) {
  await run("search", { externalId: imdb.replace("imdb://", "imdb:"), limit: 5 },
    (out) => assert.ok(out.movies?.some((movie: Live) => movie.ratingKey === detail.ratingKey && movie.library === MOVIES)));
} else console.log("skip externalId lookup (the newest movie has no IMDb id)");
// some servers index no writer tags (endpoint 404s). That is the friendly error, not a failure
if (writer) {
  await run("person_credits", { name: writer, role: "writer", library: MOVIES, watched: "all", sort: "year", order: "asc", ...pageArgs },
    (out) => assert.ok(out.total > 0))
    .catch((e) => { if (!/has no writer index/.test(e.message)) throw e; console.log("ok  person_credits writer → friendly error on un-indexed library"); });
} else console.log("skip writer credits (no writer on the newest movies)");
// an unknown composer is a friendly error either way: a missing name, or a
// server that indexes no composer tags at all (the endpoint 404s)
if (MUSIC) {
  await assert.rejects(
    tools.person_credits.handler({ name: "no-such-composer-xyz", role: "composer", library: MUSIC, watched: "all", sort: "title", order: "asc", ...pageArgs }),
    /no composer index|No composer "no-such-composer-xyz"/
  );
  console.log("ok  person_credits composer → friendly error");
} else console.log("skip composer (no Music library)");

const users = await run("list_users", {}, (out) => assert.ok(out.length > 0));
await run("watch_history", { offset: 0, limit: 10 },
  (out) => { assert.ok(out.total >= out.plays.length && out.plays.length <= 10); assert.ok(out.plays[0].user); });
await run("watch_history", { user: users.find((user: Live) => user.id > 1)?.name ?? "owner", offset: 0, limit: 5 },
  (out) => assert.ok(out.returned >= 0));

// verify the metadataItemID (ratingKey) filter: one item known to have been played
const recentPlay = (await tools.watch_history.handler({ offset: 0, limit: 1 })).plays[0];
await run("watch_history", { ratingKey: recentPlay.ratingKey, offset: 0, limit: 10 },
  (out) => { assert.ok(out.total >= 1); assert.ok(out.plays.every((play: Live) => play.ratingKey === recentPlay.ratingKey)); });
await run("now_playing", {}, (out) => assert.ok(Array.isArray(out.sessions)));
await run("library_stats", { library: OTHER ?? MOVIES, includeUserStats: false },
  (out) => { assert.ok(out.watched + out.unwatched === out.total); });

// --- discovery ---
console.log("--- discovery ---");
await run("list_media", { library: MOVIES, watched: "all", sort: "addedAt", order: "desc", ...pageArgs, fields: ["title", "year"] },
  (out) => { assert.deepEqual(Object.keys(out.items[0]).sort(), ["ratingKey", "title", "year"]); assert.equal(out.nextOffset, 5); });
await run("similar_items", { ratingKey: all.items[0].ratingKey, watched: "all", limit: 5 }, (out) => assert.ok(Array.isArray(out.items)));
await run("random_pick", { library: MOVIES, watched: "unwatched", count: 3, rated: "all", detail: false },
  (out) => { assert.equal(out.picks.length, 3); assert.ok(out.picks.every((pick: Live) => pick.viewCount === 0)); });
if (collection) await run("random_pick", { library: MOVIES, watched: "all", rated: "all", collection, count: 3, detail: true }, async (out) => {
  assert.ok(out.picks.length > 0, "collection pick matched nothing");
  for (const pick of out.picks) assert.deepEqual(pick.collections, (await tools.get_item.handler({ ratingKey: pick.ratingKey })).collections, `pick ${pick.ratingKey} names its collections`);
});
await run("continue_watching", { limit: 5 }, (out) => assert.ok(out.items.every((item: Live) => typeof item.viewOffsetMin === "number")));
await run("continue_watching", { library: TV, limit: 5 }, (out) => assert.ok(Array.isArray(out.items)));
await run("continue_watching", { limit: 5, detail: true }, (out) => assert.ok(out.items.every((item: Live) => typeof item.watched === "boolean")));
await run("get_watchlist", { offset: 0, limit: 5 }, (out) => {
  assert.ok(out.total >= out.returned && out.returned <= 5);
  assert.ok(out.items.every((item: Live) => item.inLibrary === (item.ratingKey !== null)));
});

// per-user: first non-admin Home user, if any
const home = await makePlexTv({ version: "smoke" }).homeUsers(process.env.PLEX_TOKEN!);
const kid = home.find((user) => !user.admin && !user.protected);
if (kid) {
  await run("continue_watching", { user: kid.title, limit: 5 }, (out) => assert.equal(out.user, kid.title));
  await run("list_media", { library: MOVIES, watched: "watched", sort: "lastViewedAt", order: "desc", ...pageArgs, user: kid.title },
    (out) => assert.ok(out.items.every((item: Live) => item.viewCount > 0)));
  await run("random_pick", { library: MOVIES, watched: "unwatched", count: 3, rated: "all", detail: false, user: kid.title }, (out) => {
    assert.ok(out.picks.length > 0, "Home-user pick matched nothing");
    assert.ok(out.picks.every((pick: Live) => pick.viewCount === 0));
  });
  // The checks above also pass on the admin's view, so they can't show that
  // user reached Plex. A movie watched by one of the 2 and not the other can.
  // It is found through the client, not the tools under test, so a tool that
  // drops user still finds the movie and then fails on it.
  const kidClient = await client.as(kid.title);
  const sectionKey = (await client.sectionByTitle(MOVIES)).key;
  const movies = async (view: typeof client, args: object, size: number) =>
    view.plex(`/library/sections/${sectionKey}/all`, listParams(args), { start: 0, size });
  const recentWatched = async (view: typeof client) =>
    (await movies(view, { watched: "watched", sort: "lastViewedAt", order: "desc" }, 50)).Metadata ?? [];
  const unwatchedIn = async (view: typeof client, items: Live[]) => {
    if (items.length === 0) return [];
    const seen = (await view.plex(`/library/metadata/${items.map((item) => item.ratingKey).join(",")}`)).Metadata ?? [];
    const unseen = new Set(seen.filter((item: Live) => !(Number(item.viewCount) > 0)).map((item: Live) => String(item.ratingKey)));
    return items.filter((item) => item.year != null && unseen.has(String(item.ratingKey)));
  };
  // each candidate is the movie and its watched state as the Home user sees it
  const candidates = [
    ...(await unwatchedIn(client, await recentWatched(kidClient))).map((item) => ({ item, watched: "watched" as const })),
    ...(await unwatchedIn(kidClient, await recentWatched(client))).map((item) => ({ item, watched: "unwatched" as const })),
  ];
  // A 10-item pick has to include the movie, so the filters narrow the Home
  // user's matches to 10 or fewer: the movie's year and content rating, and
  // no longer than it runs.
  const narrowTo = ({ item, watched }: typeof candidates[number]) => ({
    watched, year: Number(item.year),
    ...(item.contentRating ? { contentRating: String(item.contentRating) } : {}),
    ...(Number(item.duration) > 0 ? { maxDurationMin: Math.floor(Number(item.duration) / 60_000) + 1 } : {}),
  });
  let differs;
  for (const candidate of candidates) {
    const pool = await movies(kidClient, narrowTo(candidate), 10);
    const keys = (pool.Metadata ?? []).map((item: Live) => String(item.ratingKey));
    if (Number(pool.totalSize) <= 10 && keys.includes(String(candidate.item.ratingKey))) { differs = candidate; break; }
  }
  if (differs) {
    const key = String(differs.item.ratingKey), filters = { library: MOVIES, ...narrowTo(differs) };
    await run("list_media", { ...filters, sort: "addedAt", order: "desc", offset: 0, limit: 10, detail: false, user: kid.title },
      (out) => assert.ok(out.items.some((item: Live) => String(item.ratingKey) === key), "list_media showed the admin's watched state, not the Home user's"));
    await run("random_pick", { ...filters, count: 10, rated: "all", detail: false, user: kid.title },
      (out) => assert.ok(out.picks.some((pick: Live) => String(pick.ratingKey) === key), "random_pick showed the admin's watched state, not the Home user's"));
  } else console.log("skip per-user watched state (no movie the admin and the Home user differ on that narrows to 10 matches)");
  console.log("ok  per-user views as a Home user");
} else console.log("skip per-user views (no unprotected non-admin Home user)");
const locked = home.find((user) => user.protected);
if (locked) {
  await assert.rejects(tools.continue_watching.handler({ user: locked.title, limit: 5 }), /PIN-protected.*watch_history/s);
  console.log("ok  PIN-protected Home user → friendly error");
} else console.log("skip PIN-protected Home user (none on this server)");
await assert.rejects(tools.continue_watching.handler({ user: "no-such-user-xyz", limit: 5 }), /No Plex Home user/);
console.log("ok  unknown Home user → friendly error");

if (tools.list_clients) {
  await run("list_clients", {}, (out) => assert.ok(Array.isArray(out.clients)));
  await assert.rejects(tools.play_item.handler({ client: "no-such-client", ratingKey: "1" }), /No client/);
} else console.log(`skip playback (${readOnly ? "PLEX_READ_ONLY=1" : "PLEX_ALLOW_PLAYBACK unset"})`);

if (tools.tautulli_stats) {
  await run("tautulli_stats", { days: 30, count: 5 }, (out) => assert.ok(Object.keys(out.stats).length > 0));
  await run("tautulli_history", { days: 30, limit: 5 }, (out) => assert.ok(Array.isArray(out.plays)));
} else console.log("skip tautulli (TAUTULLI_URL/TAUTULLI_API_KEY unset)");

// --- reversible write round-trip ---
const WRITES = ["set_watched", "rate_item", "manage_playlist", "manage_collection", "manage_watchlist", "scan_library"];
if (readOnly) {
  for (const name of [...WRITES, "list_clients", "play_item"]) assert.equal(tools[name], undefined, `read-only build registers ${name}`);
  console.log("skip writes (PLEX_READ_ONLY=1)");
} else {
  console.log("--- writes (reversible) ---");
  // Each round-trip undoes itself even when a step inside it fails, so a failed
  // run leaves no test object or changed state behind. The step's error is what
  // the run reports. An undo that fails after it is logged, not thrown over it.
  const withUndo = async (body: () => Promise<unknown>, undo: () => Promise<unknown>) => {
    let failed = false;
    try {
      return await body();
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      try {
        await undo();
      } catch (e) {
        if (!failed) throw e;
        console.error(`undo failed too: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const guinea = all.items[0]; // newest movie
  const before = await tools.get_item.handler({ ratingKey: guinea.ratingKey });
  await withUndo(async () => {
    await run("rate_item", { ratingKey: guinea.ratingKey, rating: 8 }, () => {});
    const rated = await tools.get_item.handler({ ratingKey: guinea.ratingKey });
    assert.equal(rated.userRating, 8, "rating stuck");
  }, async () => {
    await run("rate_item", { ratingKey: guinea.ratingKey, rating: before.userRating }, () => {});
    assert.equal((await tools.get_item.handler({ ratingKey: guinea.ratingKey })).userRating, before.userRating, "rating restored");
  });

  // set_watched round-trip on an unwatched item
  const target = unwatched.items[0];
  const wasWatched = (await tools.get_item.handler({ ratingKey: target.ratingKey })).watched;
  await withUndo(async () => {
    await run("set_watched", { ratingKeys: [target.ratingKey], watched: true }, () => {});
    assert.equal((await tools.get_item.handler({ ratingKey: target.ratingKey })).watched, true);
  }, async () => {
    await run("set_watched", { ratingKeys: [target.ratingKey], watched: wasWatched }, () => {});
    assert.equal((await tools.get_item.handler({ ratingKey: target.ratingKey })).watched, wasWatched, "watched state restored");
  });

  // The playlist and collection undos find their test objects by title, not by
  // the id the create step returned: a create can write to the server and still
  // fail before its id is read. Each match is deleted through the tool, which
  // checks its type first. The same sweep runs before each lifecycle, so one
  // left by an interrupted run doesn't fail the closing check that the
  // round-trip left nothing behind.
  const SMOKE_TITLE = "SMOKE TEST: DELETE ME";
  const smokeIds = async (path: string): Promise<string[]> =>
    ((await client.plex(path)).Metadata ?? []).filter((entry) => entry.title === SMOKE_TITLE).map((entry) => String(entry.ratingKey));
  const deleteSmoke = async (path: string, del: (id: string) => Promise<unknown>) => {
    for (const id of await smokeIds(path)) {
      await del(id);
      console.log(`    deleted ${SMOKE_TITLE} (${id})`);
    }
  };

  // playlist lifecycle
  const keys = all.items.slice(0, 2).map((item: Live) => item.ratingKey);
  const playlists = "/playlists";
  const deletePlaylists = () => deleteSmoke(playlists, (playlistId) => tools.manage_playlist.handler({ action: "delete", playlistId, mediaType: "video", ratingKeys: [] }));
  await deletePlaylists();
  await withUndo(async () => {
    const pl = await run("manage_playlist", { action: "create", title: SMOKE_TITLE, mediaType: "video", ratingKeys: keys }, (out) => assert.ok(out.playlistId));
    await run("manage_playlist", { action: "add_items", playlistId: pl.playlistId, mediaType: "video", ratingKeys: [all.items[2].ratingKey] }, (out) => assert.equal(out.added, 1));
    await run("manage_playlist", { action: "remove_items", playlistId: pl.playlistId, mediaType: "video", ratingKeys: [keys[0]] }, (out) => assert.equal(out.removed, 1));
    await run("manage_playlist", { action: "delete", playlistId: pl.playlistId, mediaType: "video", ratingKeys: [] }, (out) => assert.ok(out.deleted));
    assert.deepEqual(await smokeIds(playlists), [], "no test playlist left");
  }, deletePlaylists);

  // collection lifecycle
  const collections = `/library/sections/${(await client.sectionByTitle(MOVIES)).key}/collections`;
  const deleteCollections = () => deleteSmoke(collections, (collectionId) => tools.manage_collection.handler({ action: "delete", collectionId, ratingKeys: [] }));
  await deleteCollections();
  await withUndo(async () => {
    const col = await run("manage_collection", { action: "create", title: SMOKE_TITLE, library: MOVIES, kind: "movie", ratingKeys: keys }, (out) => assert.ok(out.collectionId));
    await run("manage_collection", { action: "remove_items", collectionId: col.collectionId, ratingKeys: [keys[0]] }, (out) => assert.equal(out.removed, 1));
    await run("manage_collection", { action: "delete", collectionId: col.collectionId, ratingKeys: [] }, (out) => assert.ok(out.deleted));
    assert.deepEqual(await smokeIds(collections), [], "no test collection left");
  }, deleteCollections);

  // watchlist round-trip on a library movie that isn't on it yet. The undo
  // removes it, which plex.tv accepts whether or not the add landed
  const watchlistKeys = async (): Promise<string[]> => {
    const keys: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page: Live = await tools.get_watchlist.handler({ offset, limit: 100 });
      keys.push(...page.items.map((item: Live) => item.ratingKey).filter(Boolean));
      offset = page.nextOffset;
    }
    return keys;
  };
  const listed = new Set(await watchlistKeys());
  const pick = all.items.find((item: Live) => !listed.has(item.ratingKey));
  if (pick) {
    await withUndo(async () => {
      await run("manage_watchlist", { action: "add", ratingKeys: [pick.ratingKey] }, (out) => assert.equal(out.items.length, 1));
      await run("get_watchlist", { offset: 0, limit: 1 }, (out) => assert.equal(out.items[0]?.ratingKey, pick.ratingKey, "newest entry first"));
    }, async () => {
      await run("manage_watchlist", { action: "remove", ratingKeys: [pick.ratingKey] }, () => {});
      assert.ok(!(await watchlistKeys()).includes(pick.ratingKey), "watchlist entry removed");
    });
  } else console.log("skip watchlist round-trip (every newest movie is already on the watchlist)");

  // scan trigger. Harmless: Plex just re-reads its own folders
  await run("scan_library", { library: MOVIES }, (out) => assert.equal(out.scanning, MOVIES));
}

console.log("\nSMOKE PASSED");
