// test/filters.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND_TYPE, SORT_FIELDS, SORT_KEYS, listParams, sinceValue, cutoffEpoch } from "#dist/lib/filters.js";
import { KINDS } from "#dist/lib/tools-read.js";

test("KIND_TYPE maps all eight kinds", () => {
  assert.deepEqual(KIND_TYPE, {
    movie: 1, show: 2, season: 3, episode: 4, artist: 8, album: 9, track: 10,
  });
});

// The tool schemas take their enums from these hand-written lists, so a kind
// or sort field added to one table and not its list would be unreachable.
test("KINDS lists every KIND_TYPE kind, then collection", () => {
  assert.deepEqual(KINDS, [...Object.keys(KIND_TYPE), "collection"]);
});

test("SORT_KEYS lists every SORT_FIELDS key", () => {
  assert.deepEqual(SORT_KEYS, Object.keys(SORT_FIELDS));
});

test("listParams: watched → viewCount>> operator param", () => {
  assert.equal(listParams({ kind: "movie", watched: "watched" })["viewCount>>"], "0");
});

test("listParams: unwatched → unwatched=1", () => {
  assert.equal(listParams({ kind: "movie", watched: "unwatched" }).unwatched, "1");
});

test("listParams: rated → userRating>> operator param", () => {
  assert.equal(listParams({ kind: "movie", rated: "rated" })["userRating>>"], "0");
});

test("listParams: unrated → userRating=-1 sentinel", () => {
  assert.equal(listParams({ kind: "movie", rated: "unrated" }).userRating, "-1");
});

test("listParams: watched and rated all/undefined → no params", () => {
  const params = { type: 1, sort: "addedAt:desc" };
  assert.deepEqual(listParams({ kind: "movie", watched: "all", rated: "all" }), params);
  assert.deepEqual(listParams({ kind: "movie" }), params);
});

test("listParams: rated spreads in; userRating sorts", () => {
  assert.equal(listParams({ kind: "movie", rated: "rated" })["userRating>>"], "0");
  assert.equal(listParams({ kind: "movie", sort: "userRating", order: "asc" }).sort, "userRating:asc");
});

test("listParams: kind → type number", () => {
  assert.equal(listParams({ kind: "movie" }).type, 1);
  assert.equal(listParams({ kind: "track" }).type, 10);
});

test("listParams: decade accepts '1970s' and '1970'", () => {
  assert.equal(listParams({ kind: "movie", decade: "1970s" }).decade, "1970");
  assert.equal(listParams({ kind: "movie", decade: "1970" }).decade, "1970");
});

test("listParams: bad decade throws with example", () => {
  assert.throws(() => listParams({ kind: "movie", decade: "seventies" }), /1970s/);
});

test("listParams: addedSince relative passes through, ISO converts to epoch", () => {
  assert.equal(listParams({ kind: "movie", addedSince: "-30d" })["addedAt>>"], "-30d");
  assert.equal(
    listParams({ kind: "movie", addedSince: "2026-01-01" })["addedAt>>"],
    String(Math.floor(Date.parse("2026-01-01") / 1000))
  );
});

test("listParams: bad addedSince throws", () => {
  assert.throws(() => listParams({ kind: "movie", addedSince: "yesterday" }), /-30d/);
});

test("sinceValue: relative passes through, ISO converts, garbage throws", () => {
  assert.equal(sinceValue("-7d"), "-7d");
  assert.equal(sinceValue("2026-01-01"), String(Math.floor(Date.parse("2026-01-01") / 1000)));
  assert.throws(() => sinceValue("yesterday"), /Bad since "yesterday".*-30d/);
  assert.throws(() => sinceValue("yesterday", "addedSince"), /Bad addedSince/);
});

test("cutoffEpoch: relative counts back in calendar units from now, ISO converts", () => {
  const now = Date.parse("2026-03-31T12:00:00Z");
  const at = (iso: string) => String(Date.parse(iso) / 1000);
  assert.equal(cutoffEpoch("-3y", "x", now), at("2023-03-31T12:00:00Z"));
  assert.equal(cutoffEpoch("-30d", "x", now), at("2026-03-01T12:00:00Z"));
  assert.equal(cutoffEpoch("-2w", "x", now), at("2026-03-17T12:00:00Z"));
  assert.equal(cutoffEpoch("-1mon", "x", now), at("2026-03-03T12:00:00Z")); // Feb 31 overflows
  assert.equal(cutoffEpoch("2024-01-01", "x", now), at("2024-01-01T00:00:00Z"));
});

test("listParams: bad lastViewedBefore/After throw the addedSince error shape", () => {
  const shape = (label: string) => new RegExp(`Error: Bad ${label} "yesterday"\\. Use ISO date \\("2026-01-01"\\) or relative \\("-30d"\\)$`);
  assert.throws(() => listParams({ kind: "movie", addedSince: "yesterday" }), shape("addedSince"));
  assert.throws(() => listParams({ kind: "movie", lastViewedBefore: "yesterday" }), shape("lastViewedBefore"));
  assert.throws(() => listParams({ kind: "movie", lastViewedAfter: "yesterday" }), shape("lastViewedAfter"));
});

test("listParams: maxDurationMin → duration<< in ms", () => {
  assert.equal(listParams({ kind: "movie", maxDurationMin: 100 })["duration<<"], "6000000");
});

test("listParams: sort maps field and order; title uses titleSort", () => {
  assert.equal(listParams({ kind: "movie", sort: "title", order: "asc" }).sort, "titleSort:asc");
  assert.equal(listParams({ kind: "movie", sort: "viewCount", order: "desc" }).sort, "viewCount:desc");
  assert.equal(listParams({ kind: "movie" }).sort, "addedAt:desc"); // defaults
  assert.equal(listParams({ kind: "movie", sort: "random" }).sort, "random");
});

test("listParams: tag IDs land as string params", () => {
  const p = listParams({ kind: "movie" }, { director: 1001, genre: 7 });
  assert.equal(p.director, "1001");
  assert.equal(p.genre, "7");
  assert.equal(listParams({ kind: "track" }, { composer: 4242 }).composer, "4242");
});

test("listParams: year and contentRating pass through", () => {
  const p = listParams({ kind: "movie", year: 1994, contentRating: "PG-13" });
  assert.equal(p.year, "1994");
  assert.equal(p.contentRating, "PG-13");
});
