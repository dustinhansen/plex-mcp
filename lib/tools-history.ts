/** Watch history, the sessions playing now and the server's users. */
import { z } from "zod";
import { historyDict, sessionDict } from "./format.js";
import { defineTool, PLEX_ID, READ_ONLY } from "../types/tool-registration.js";
import type { PlexClient, Query } from "../types/boundaries.js";

/** `viewedAt>` is the operator this endpoint honors. The `>>` form the
 *  library endpoints take is not rejected here, it is ignored, and the filter
 *  returns every row. So this helper stays separate from `sinceValue` in
 *  filters.ts, and the operators below stay single-angle.
 *
 *    /status/sessions/history/all  viewedAt>  → only the rows after the date
 *                                  viewedAt>> → every row
 *    /library/sections/{key}/all   addedAt>  and  addedAt>>  behave identically */
const epoch = (label: string, value: string) => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Bad ${label} "${value}". Use an ISO date like 2026-06-01`);
  return String(Math.floor(ms / 1000));
};

export function historyTools(root: PlexClient) {
  return {
    watch_history: defineTool({
      title: "Watch history",
      annotations: READ_ONLY,
      description:
        "Watch/listen history across ALL users: who played what, when. Filter " +
        "by user (name or account id), library, time window (since/until, ISO " +
        "dates), or a specific item (ratingKey: answers 'has X seen Y?'). " +
        "Sorted newest first. kind filters the returned page client-side " +
        "(movie/episode/track). total reflects the unfiltered count.",
      inputSchema: {
        user: z.string().optional(),
        library: z.string().optional(),
        kind: z.enum(["movie", "episode", "track"]).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        ratingKey: PLEX_ID.optional().describe("limit history to one item"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: async (args) => {
        const params: Query = { sort: "viewedAt:desc" };
        if (args.user) params.accountID = (await root.accountByName(args.user)).id;
        if (args.library) params.librarySectionID = (await root.sectionByTitle(args.library)).key;
        if (args.since) params["viewedAt>"] = epoch("since", args.since);
        if (args.until) params["viewedAt<"] = epoch("until", args.until);
        if (args.ratingKey) params.metadataItemID = args.ratingKey;
        const container = await root.plex("/status/sessions/history/all", params, { start: args.offset, size: args.limit });
        const names = Object.fromEntries((await root.accounts()).map((account) => [account.id, account.name]));
        let plays = (container.Metadata ?? []).map((play) => historyDict(play, names));
        if (args.kind) plays = plays.filter((play) => play.kind === args.kind);
        return { total: container.totalSize ?? plays.length, offset: args.offset, returned: plays.length, plays };
      },
    }),

    now_playing: defineTool({
      title: "Now playing",
      annotations: READ_ONLY,
      description: "What is playing on the server right now: user, item, player, progress.",
      inputSchema: {},
      handler: async () => {
        const container = await root.plex("/status/sessions");
        return { sessions: (container.Metadata ?? []).map(sessionDict) };
      },
    }),

    list_users: defineTool({
      title: "List users",
      annotations: READ_ONLY,
      description:
        "All Plex accounts on this server with ids. Use names or ids with " +
        "watch_history's user filter.",
      inputSchema: {},
      handler: async () => await root.accounts(),
    }),
  };
}
