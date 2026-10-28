/** Richer stats/history from Tautulli, when present. */
import { z } from "zod";
import { isoDay } from "./format.js";
import { defineTool, PLEX_ID, READ_ONLY } from "../types/tool-registration.js";
import type { TautulliClient } from "../types/boundaries.js";

const hours = (secs: number | undefined) => Math.round(((secs ?? 0) / 3600) * 10) / 10;

export function tautulliTools(tautulli: TautulliClient) {
  return {
    tautulli_stats: defineTool({
      title: "Tautulli stats",
      annotations: READ_ONLY,
      description:
        "Tautulli home stats over the last N days: most watched movies/shows/music, " +
        "most active users, most popular items, platforms, and more. Each stat is a " +
        "ranked list with plays and hours.",
      inputSchema: {
        days: z.number().int().min(1).max(3650).default(30),
        count: z.number().int().min(1).max(50).default(10),
      },
      handler: async ({ days, count }) => {
        const response = await tautulli.call("get_home_stats", { time_range: days, stats_count: count, stats_type: "plays" });
        type StatRow = { title: string | null; user: string | null; plays: number | null; hours: number; usersWatched: number | null };
        const stats: Record<string, StatRow[]> = {};
        for (const stat of Array.isArray(response) ? response : []) {
          stats[stat.stat_id] = (stat.rows ?? []).map((row) => ({
            title: row.title || null,
            user: row.friendly_name || row.user || null,
            plays: row.total_plays ?? null,
            hours: hours(row.total_duration),
            usersWatched: row.users_watched ?? null,
          }));
        }
        return { days, stats };
      },
    }),

    tautulli_history: defineTool({
      title: "Tautulli history",
      annotations: READ_ONLY,
      description:
        "Per-play history from Tautulli with platform, player, and percent watched " +
        "(more detail than watch_history). Filter by user, one item (ratingKey), and a " +
        "window of days.",
      inputSchema: {
        user: z.string().optional(),
        ratingKey: PLEX_ID.optional(),
        days: z.number().int().min(1).max(3650).default(30),
        limit: z.number().int().min(1).max(500).default(50),
      },
      handler: async ({ user, ratingKey, days, limit }) => {
        const after = Math.floor((Date.now() - days * 86_400_000) / 1000);
        const response = await tautulli.call("get_history", {
          user, rating_key: ratingKey, after: isoDay(after), length: limit, order_column: "date", order_dir: "desc",
        });
        const history = Array.isArray(response) ? undefined : response;
        const plays = (history?.data ?? []).map((row) => ({
          user: row.user ?? null,
          title: row.full_title ?? row.title ?? null,
          kind: row.media_type ?? null,
          ratingKey: row.rating_key != null ? String(row.rating_key) : null,
          date: row.date ? new Date(row.date * 1000).toISOString() : null,
          platform: row.platform ?? null,
          player: row.player ?? null,
          percentComplete: row.percent_complete ?? null,
          watched: row.watched_status === 1,
          durationMin: row.duration != null ? Math.round(row.duration / 60) : null,
        }));
        return { total: history?.recordsFiltered ?? plays.length, plays };
      },
    }),
  };
}
