/** Formatters: Plex Metadata → compact agent-friendly records.
 *  Every record carries watched/viewCount/lastViewedAt, so watched media is
 *  never invisible to a caller. */

import type { PlexMetadata, PlexSection } from "../types/boundaries.js";

type RecordValue = string | number | boolean | null | string[] | ToolRecord | ToolRecord[];
export interface ToolRecord { [key: string]: RecordValue | undefined }

const tags = (items: PlexMetadata["Genre"] | undefined): string[] => (items ?? []).map((item) => item.tag);
export const iso = (epoch: number | undefined): string | null => epoch ? new Date(epoch * 1000).toISOString() : null;
export const isoDay = (epoch: number | undefined): string | null => epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
export const mins = (milliseconds: number | undefined): number | null => milliseconds ? Math.round(milliseconds / 60_000) : null;

export function isWatched(metadata: PlexMetadata): boolean {
  if (metadata.type === "show" || metadata.type === "season") {
    const leaves = metadata.leafCount ?? 0;
    return leaves > 0 && (metadata.viewedLeafCount ?? 0) >= leaves;
  }
  return (metadata.viewCount ?? 0) > 0;
}

export function itemDict(metadata: PlexMetadata, detail = false): ToolRecord {
  const record: ToolRecord = {
    title: metadata.title,
    kind: metadata.type,
    year: metadata.year ?? null,
    ratingKey: metadata.ratingKey,
    watched: isWatched(metadata),
    viewCount: metadata.viewCount ?? 0,
    lastViewedAt: iso(metadata.lastViewedAt),
    addedAt: isoDay(metadata.addedAt),
  };
  switch (metadata.type) {
    case "movie":
      Object.assign(record, {
        genres: tags(metadata.Genre),
        rating: metadata.rating ?? null,
        audienceRating: metadata.audienceRating ?? null,
        userRating: metadata.userRating ?? null,
        contentRating: metadata.contentRating ?? null,
        durationMin: mins(metadata.duration),
      });
      break;
    case "show":
      Object.assign(record, {
        seasons: metadata.childCount ?? null,
        episodes: metadata.leafCount ?? null,
        episodesWatched: metadata.viewedLeafCount ?? 0,
        genres: tags(metadata.Genre),
        contentRating: metadata.contentRating ?? null,
      });
      break;
    case "season":
      Object.assign(record, {
        show: metadata.parentTitle ?? null,
        index: metadata.index ?? null,
        episodes: metadata.leafCount ?? null,
        episodesWatched: metadata.viewedLeafCount ?? 0,
      });
      break;
    case "episode":
      Object.assign(record, {
        show: metadata.grandparentTitle ?? null,
        season: metadata.parentIndex ?? null,
        episode: metadata.index ?? null,
        durationMin: mins(metadata.duration),
      });
      break;
    case "artist":
      Object.assign(record, { genres: tags(metadata.Genre) });
      break;
    case "album":
      Object.assign(record, {
        artist: metadata.parentTitle ?? null,
        tracks: metadata.leafCount ?? null,
        genres: tags(metadata.Genre),
      });
      break;
    case "track":
      Object.assign(record, {
        artist: metadata.grandparentTitle ?? null,
        album: metadata.parentTitle ?? null,
        trackNo: metadata.index ?? null,
        durationMin: mins(metadata.duration),
      });
      break;
    case "collection":
      Object.assign(record, { items: metadata.childCount ?? null });
      break;
    case "playlist":
      Object.assign(record, {
        items: metadata.leafCount ?? null,
        playlistType: metadata.playlistType ?? null,
      });
      break;
  }
  if (detail) Object.assign(record, {
    directors: tags(metadata.Director),
    writers: tags(metadata.Writer),
    actors: tags(metadata.Role).slice(0, 8),
    countries: tags(metadata.Country),
    collections: tags(metadata.Collection),
    studio: metadata.studio ?? null,
    summary: (metadata.summary ?? "").slice(0, 400),
    ...(metadata.type === "movie" ? {} : { userRating: metadata.userRating ?? null }),
  });
  return record;
}

/** A section's Plex `type` is its scanner type, not the library type Plex names in its UI. */
const PERSONAL_MEDIA_AGENTS = new Set(["com.plexapp.agents.none", "tv.plex.agents.none"]);
/** A personal-media agent attaches no IMDb, TMDB or TVDB ids to its items. */
export const hasPersonalMediaAgent = (section: PlexSection): boolean => section.agent ? PERSONAL_MEDIA_AGENTS.has(section.agent) : false;
const isPersonalMedia = (section: PlexSection): boolean => hasPersonalMediaAgent(section) || /video files|personal media/i.test(section.scanner ?? "");

/** The library type as named in Plex's own "Add Library" UI. */
export function libraryType(section: PlexSection): string {
  switch (section.type) {
    case "movie": return isPersonalMedia(section) ? "Other Videos" : "Movies";
    case "show": return "TV Shows";
    case "artist": return "Music";
    case "photo": return "Photos";
    default: return section.type ?? "Unknown";
  }
}

export function sectionDict(section: PlexSection): ToolRecord {
  return {
    title: section.title,
    libraryType: libraryType(section),
    type: section.type,
    key: section.key,
    agent: section.agent ?? null,
    scanner: section.scanner ?? null,
    refreshing: Boolean(section.refreshing),
  };
}

/** Extras (type "clip"): Plex-provided streaming trailers have no Part.file. */
export function extraDict(metadata: PlexMetadata): ToolRecord {
  return {
    title: metadata.title,
    subtype: metadata.subtype ?? null,
    ratingKey: metadata.ratingKey,
    durationMin: mins(metadata.duration),
    paths: (metadata.Media ?? [])
      .flatMap((media) => media.Part ?? [])
      .flatMap((part) => part.file ? [part.file] : []),
  };
}

/** Who a play belongs to: the account's name, its id when it has no name, or "unknown" when Plex gives no account. */
export function playUser(accountID: number | undefined, userNames: Record<number, string>): string {
  return accountID === undefined ? "unknown" : userNames[accountID] ?? String(accountID);
}

export function historyDict(history: PlexMetadata, userNames: Record<number, string> = {}): ToolRecord {
  return {
    title: history.title,
    kind: history.type,
    show: history.grandparentTitle && history.type === "episode" ? history.grandparentTitle : null,
    artist: history.grandparentTitle && history.type === "track" ? history.grandparentTitle : null,
    viewedAt: iso(history.viewedAt),
    user: playUser(history.accountID, userNames),
    accountID: history.accountID,
    ratingKey: history.ratingKey ?? null,
  };
}

export function sessionDict(session: PlexMetadata): ToolRecord {
  return {
    user: session.User?.title ?? null,
    title: session.title,
    kind: session.type,
    show: session.grandparentTitle ?? null,
    player: session.Player?.product ?? null,
    state: session.Player?.state ?? null,
    progressPct: session.duration ? Math.round(((session.viewOffset ?? 0) / session.duration) * 100) : null,
  };
}

/** Project a record to requested keys. ratingKey always survives for follow-up actions. */
export function project(item: ToolRecord, fields?: string[]): ToolRecord {
  if (!fields?.length) return item;
  const output: ToolRecord = { ratingKey: item.ratingKey };
  for (const field of fields) if (Object.hasOwn(item, field)) output[field] = item[field];
  return output;
}
