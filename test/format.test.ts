import { test } from "node:test";
import assert from "node:assert/strict";
import { itemDict, isWatched, historyDict, sessionDict, extraDict } from "#dist/lib/format.js";
import type { PlexPart } from "#dist/types/boundaries.js";

const MOVIE = {
  type: "movie", title: "The 'Burbs", year: 1989, ratingKey: "12345",
  viewCount: 2, lastViewedAt: 1750000000, addedAt: 1600000000,
  duration: 6120000, rating: 5.6, audienceRating: 6.8, contentRating: "PG",
  Genre: [{ tag: "Comedy" }, { tag: "Thriller" }],
  Director: [{ tag: "Joe Dante" }], Writer: [{ tag: "Dana Olsen" }],
  Role: [{ tag: "Tom Hanks" }, { tag: "Bruce Dern" }],
  Country: [{ tag: "United States of America" }],
  Collection: [{ tag: "Suburbia Collection" }],
  studio: "Imagine Entertainment", summary: "S".repeat(500), userRating: 8,
};

const SHOW_DONE = { type: "show", title: "Severance", ratingKey: "9", leafCount: 19, viewedLeafCount: 19, childCount: 2 };
const SHOW_PARTIAL = { type: "show", title: "Alone", ratingKey: "8", leafCount: 100, viewedLeafCount: 40, childCount: 11 };
const EPISODE = { type: "episode", title: "Woe's Hollow", ratingKey: "77", grandparentTitle: "Severance", parentIndex: 2, index: 4, viewCount: 1, duration: 2700000 };
const TRACK = { type: "track", title: "Dancehall", ratingKey: "55", grandparentTitle: "311", parentTitle: "Grassroots", index: 3, viewCount: 12, duration: 190000 };

test("itemDict always has the universal fields", () => {
  for (const m of [MOVIE, SHOW_DONE, EPISODE, TRACK]) {
    const d = itemDict(m);
    for (const f of ["title", "kind", "year", "ratingKey", "watched", "viewCount", "lastViewedAt", "addedAt"]) {
      assert.ok(f in d, `${m.type} missing ${f}`);
    }
  }
});

test("movie: fields, duration rounding, ISO dates", () => {
  const d = itemDict(MOVIE);
  assert.equal(d.kind, "movie");
  assert.equal(d.watched, true);
  assert.equal(d.viewCount, 2);
  assert.equal(d.durationMin, 102);
  assert.equal(d.lastViewedAt, new Date(1750000000 * 1000).toISOString());
  assert.equal(d.addedAt, "2020-09-13");
  assert.deepEqual(d.genres, ["Comedy", "Thriller"]);
  assert.equal(d.directors, undefined); // compact has no people
});

test("movie compact record carries userRating; missing → null", () => {
  assert.equal(itemDict(MOVIE).userRating, 8);
  assert.equal(itemDict({ type: "movie", title: "Bare", ratingKey: "1" }).userRating, null);
});

test("movie detail: people, truncated summary, userRating", () => {
  const d = itemDict(MOVIE, true);
  assert.deepEqual(d.directors, ["Joe Dante"]);
  assert.deepEqual(d.actors, ["Tom Hanks", "Bruce Dern"]);
  assert.equal((d.summary as string).length, 400);
  assert.equal(d.userRating, 8);
  assert.equal(d.studio, "Imagine Entertainment");
});

test("missing fields → null/0, not crash", () => {
  const d = itemDict({ type: "movie", title: "Bare", ratingKey: "1" });
  assert.equal(d.year, null);
  assert.equal(d.watched, false);
  assert.equal(d.viewCount, 0);
  assert.equal(d.lastViewedAt, null);
  assert.equal(d.durationMin, null);
  assert.deepEqual(d.genres, []);
});

test("show watched = all leaves viewed; episode counts exposed", () => {
  assert.equal(isWatched(SHOW_DONE), true);
  assert.equal(isWatched(SHOW_PARTIAL), false);
  const d = itemDict(SHOW_PARTIAL);
  assert.equal(d.episodes, 100);
  assert.equal(d.episodesWatched, 40);
  assert.equal(d.seasons, 11);
});

test("episode and track context fields", () => {
  const e = itemDict(EPISODE);
  assert.equal(e.show, "Severance");
  assert.equal(e.season, 2);
  assert.equal(e.episode, 4);
  const t = itemDict(TRACK);
  assert.equal(t.artist, "311");
  assert.equal(t.album, "Grassroots");
  assert.equal(t.trackNo, 3);
});

test("extraDict: local trailer exposes file path", () => {
  const d = extraDict({
    type: "clip", subtype: "trailer", title: "The 'Burbs Trailer", ratingKey: "9001",
    duration: 150000,
    Media: [{ Part: [{ file: "/data/movies/The Burbs (1989)/The Burbs-trailer.mp4" }] }],
  });
  assert.equal(d.subtype, "trailer");
  assert.equal(d.durationMin, 3);
  assert.deepEqual(d.paths, ["/data/movies/The Burbs (1989)/The Burbs-trailer.mp4"]);
});

test("extraDict: streaming trailer (no file) → empty paths", () => {
  const d = extraDict({
    type: "clip", subtype: "trailer", title: "Streaming Trailer", ratingKey: "9002",
    duration: 120000,
    Media: [{ Part: [{ key: "/services/iva/assets/123/video.mp4" } as PlexPart] }],
  });
  assert.deepEqual(d.paths, []);
});

test("extraDict: missing Media/subtype → null/empty, not crash", () => {
  const d = extraDict({ type: "clip", title: "Bare Clip", ratingKey: "9003" });
  assert.equal(d.subtype, null);
  assert.equal(d.durationMin, null);
  assert.deepEqual(d.paths, []);
});

test("historyDict maps account to name with fallback", () => {
  const h = { title: "Gary", type: "movie", viewedAt: 1751000000, accountID: 4242, ratingKey: "42" };
  const d = historyDict(h, { 4242: "alice" });
  assert.equal(d.user, "alice");
  assert.equal(d.viewedAt, new Date(1751000000 * 1000).toISOString());
  assert.equal(historyDict(h, {}).user, "4242");
});

test("historyDict names a play with no account unknown and an unnamed account by id", () => {
  const h = { title: "Gary", type: "movie", viewedAt: 1751000000, ratingKey: "42" };
  assert.equal(historyDict(h, { 4242: "alice" }).user, "unknown");
  assert.equal(historyDict({ ...h, accountID: 7 }, { 4242: "alice" }).user, "7");
});

test("sessionDict computes progress", () => {
  const s = { title: "The Pop", type: "episode", grandparentTitle: "WWE: Unreal",
    duration: 3000000, viewOffset: 1500000,
    User: { title: "example-viewer" }, Player: { product: "Plex for Roku", state: "playing" } };
  const d = sessionDict(s);
  assert.equal(d.user, "example-viewer");
  assert.equal(d.progressPct, 50);
  assert.equal(d.state, "playing");
  assert.equal(d.show, "WWE: Unreal");
});
