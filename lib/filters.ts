/** Pure query-param builders for Plex library filtering, the kind and type
 *  numbers they filter on, and the library item URIs that writes and play
 *  queues take.
 *  Plex filter operators live in the param NAME: `viewCount>>` means >,
 *  `duration<<` means <. */

import type { Query } from "../types/boundaries.js";

/** The identifier Plex gives its library provider, used in item URIs and writes. */
export const IDENT = "com.plexapp.plugins.library";
/** A library item URI, the form Plex takes for playlists, collections and play queues.
 *  A caller refuses a server that reports no machine id rather than send
 *  `server://undefined/...`. */
export const libraryItemUri = (machineId: string, ratingKeys: string[]): string =>
  `server://${machineId}/${IDENT}/library/metadata/${ratingKeys.join(",")}`;

export const KIND_TYPE = { movie: 1, show: 2, season: 3, episode: 4, artist: 8, album: 9, track: 10 } as const;
const SECTION_DEFAULT_KIND = { movie: "movie", show: "show", artist: "artist" } as const;

/** Movie, show and artist sections have a kind of their own. A photo section
 *  has none. */
export const hasDefaultKind = (type: string | undefined): type is keyof typeof SECTION_DEFAULT_KIND =>
  Object.hasOwn(SECTION_DEFAULT_KIND, type ?? "");

/** The kind a section lists when no kind is asked for, falling back to movie
 *  for a section with no kind of its own. */
export const sectionKind = (type: string | undefined): keyof typeof KIND_TYPE =>
  hasDefaultKind(type) ? SECTION_DEFAULT_KIND[type] : "movie";
export const SORT_FIELDS = {
  title: "titleSort",
  year: "year",
  rating: "rating",
  audienceRating: "audienceRating",
  userRating: "userRating",
  addedAt: "addedAt",
  lastViewedAt: "lastViewedAt",
  viewCount: "viewCount",
  duration: "duration",
  random: "random",
} as const;
export const SORT_KEYS = ["title", "year", "rating", "audienceRating", "userRating", "addedAt", "lastViewedAt", "viewCount", "duration", "random"] as const;

type ListArguments = {
  kind?: keyof typeof KIND_TYPE | "collection";
  watched?: "all" | "watched" | "unwatched";
  rated?: "all" | "rated" | "unrated";
  decade?: string;
  addedSince?: string;
  lastViewedBefore?: string;
  lastViewedAfter?: string;
  sort?: keyof typeof SORT_FIELDS;
  order?: string;
  year?: number;
  contentRating?: string;
  maxDurationMin?: number;
};

function watchedParams(watched: ListArguments["watched"] = "all"): Query {
  if (watched === "watched") return { "viewCount>>": "0" };
  if (watched === "unwatched") return { unwatched: "1" };
  return {};
}

function ratedParams(rated: ListArguments["rated"] = "all"): Query {
  if (rated === "rated") return { "userRating>>": "0" };
  if (rated === "unrated") return { userRating: "-1" };
  return {};
}

function decadeParams(decade: ListArguments["decade"]): Query {
  if (decade == null) return {};
  const match = decade.match(/^(\d{4})s?$/);
  if (!match?.[1]) throw new Error(`Bad decade "${decade}". Use e.g. "1970s"`);
  return { decade: match[1] };
}

const RELATIVE = /^-(\d+)(d|w|mon|y)$/;

/** ISO date or relative "-30d" → Plex filter value. */
export function sinceValue(since: string, label = "since"): string {
  if (RELATIVE.test(since)) return since;
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) throw new Error(`Bad ${label} "${since}". Use ISO date ("2026-01-01") or relative ("-30d")`);
  return String(Math.floor(timestamp / 1000));
}

function addedSinceParams(addedSince: ListArguments["addedSince"]): Query {
  return addedSince ? { "addedAt>>": sinceValue(addedSince, "addedSince") } : {};
}

/** ISO date or relative "-3y" → epoch seconds. Unlike sinceValue, a relative
 *  value is resolved here rather than handed to Plex, so the cutoff is one this
 *  code defines and a caller can compute the same instant. It counts back from
 *  now in calendar units: "-1mon" from March 31 lands on March 3 (UTC date
 *  overflow), never on an invalid date. */
export function cutoffEpoch(value: string, label: string, now = Date.now()): string {
  const since = sinceValue(value, label);
  const match = since.match(RELATIVE);
  if (!match) return since;
  const n = Number(match[1]);
  const date = new Date(now);
  if (match[2] === "d") date.setUTCDate(date.getUTCDate() - n);
  if (match[2] === "w") date.setUTCDate(date.getUTCDate() - 7 * n);
  if (match[2] === "mon") date.setUTCMonth(date.getUTCMonth() - n);
  if (match[2] === "y") date.setUTCFullYear(date.getUTCFullYear() - n);
  return String(Math.floor(date.getTime() / 1000));
}

/** Plex counts a never-watched item as last viewed before any cutoff, so
 *  lastViewedBefore alone includes it. watched="watched" leaves it out. */
function lastViewedParams(before: ListArguments["lastViewedBefore"], after: ListArguments["lastViewedAfter"]): Query {
  const params: Query = {};
  if (before) params["lastViewedAt<<"] = cutoffEpoch(before, "lastViewedBefore");
  if (after) params["lastViewedAt>>"] = cutoffEpoch(after, "lastViewedAfter");
  return params;
}

function sortParams(sort: ListArguments["sort"] = "addedAt", order = "desc"): Query {
  const field = SORT_FIELDS[sort];
  return field === "random" ? { sort: "random" } : { sort: `${field}:${order}` };
}

const TAG_FILTERS = ["genre", "collection", "country", "studio", "director", "actor", "writer", "composer"] as const;

/** Build the full param object for /library/sections/{key}/all. */
export function listParams(args: ListArguments, tagIds: Record<string, string | number | undefined> = {}): Query {
  const type = args.kind === "collection" ? undefined : args.kind ? KIND_TYPE[args.kind] : 1;
  const params: Query = {
    type,
    ...watchedParams(args.watched),
    ...ratedParams(args.rated),
    ...decadeParams(args.decade),
    ...addedSinceParams(args.addedSince),
    ...lastViewedParams(args.lastViewedBefore, args.lastViewedAfter),
    ...sortParams(args.sort, args.order),
  };
  if (args.year != null) params.year = String(args.year);
  if (args.contentRating) params.contentRating = args.contentRating;
  if (args.maxDurationMin != null) params["duration<<"] = String(args.maxDurationMin * 60_000);
  for (const filter of TAG_FILTERS) if (tagIds[filter] != null) params[filter] = String(tagIds[filter]);
  return params;
}
