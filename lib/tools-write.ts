/** Curation writes + scan trigger. Nothing here can delete, move, or modify media
 *  files or metadata. Playlist/collection deletion never touches members. */
import { z } from "zod";
import { IDENT, KIND_TYPE, libraryItemUri } from "./filters.js";
import { libraryType } from "./format.js";
import { fetchItems } from "./tools-read.js";
import { defineTool, PLEX_ID } from "../types/tool-registration.js";
import type { PlexClient } from "../types/boundaries.js";

function need(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
/** Sends a per-item write for each key, in order. A failure partway throws the
 *  upstream message, then the keys already changed, so a re-run can skip them. */
async function eachKey(keys: string[], changed: string, send: (key: string, index: number) => Promise<unknown>) {
  const done: string[] = [];
  for (const [index, key] of keys.entries()) {
    try {
      await send(key, index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}. ${done.length ? `Already ${changed}: ${done.join(", ")}` : "Nothing was changed"}.`);
    }
    done.push(key);
  }
}
/** The collection kind each library type holds, keyed by Plex's section type. A
 *  music library's collections are of albums, the one music kind
 *  manage_collection offers. */
const SECTION_COLLECTION_KIND = new Map<string | undefined, "movie" | "show" | "album">([["movie", "movie"], ["show", "show"], ["artist", "album"]]);
/** The kinds manage_watchlist takes: the ones a Plex watchlist offers. */
const WATCHLIST_KINDS = new Set(["movie", "show"]);

export function writeTools(root: PlexClient) {
  const itemUri = async (tool: string, ratingKeys: string[]) => {
    const machineId = await root.machineId();
    need(machineId, `The Plex server did not report its machine identifier, which ${tool} needs to name the items it adds.`);
    return libraryItemUri(machineId, ratingKeys);
  };

  return {
    set_watched: defineTool({
      title: "Mark watched or unwatched",
      // Not idempotent: each mark-watched scrobbles, so a repeat records another play.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Mark specific items watched or unwatched by ratingKey (owner account). " +
        "Explicit keys only. Marking watched also records a play. If Plex fails " +
        "partway, the error names the keys already marked.",
      inputSchema: {
        ratingKeys: z.array(PLEX_ID).min(1).max(100),
        watched: z.boolean(),
      },
      handler: async ({ ratingKeys, watched }) => {
        // Plex takes one item per call, so a failure partway names what already
        // changed: re-sending a key that was marked watched records another play.
        await eachKey(ratingKeys, watched ? "marked watched" : "marked unwatched",
          (key) => root.plex(watched ? "/:/scrobble" : "/:/unscrobble", { key, identifier: IDENT }));
        return { updated: ratingKeys.length, watched };
      },
    }),

    rate_item: defineTool({
      title: "Rate item",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Set (0-10) or clear (null) the owner's rating on an item.",
      inputSchema: {
        ratingKey: PLEX_ID,
        rating: z.number().min(0).max(10).nullable(),
      },
      handler: async ({ ratingKey, rating }) => {
        await root.plex("/:/rate", { key: ratingKey, identifier: IDENT, rating: rating ?? -1 });
        return { ratingKey, rating };
      },
    }),

    manage_playlist: defineTool({
      title: "Manage playlist",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "Create, extend, prune, or delete a playlist. create: title + ratingKeys " +
        "(+ mediaType video|audio). add_items/remove_items: playlistId + " +
        "ratingKeys. delete: playlistId (deletes ONLY the playlist, never media). " +
        "If Plex fails partway through remove_items, the error names the keys " +
        "already removed.",
      inputSchema: {
        action: z.enum(["create", "add_items", "remove_items", "delete"]),
        playlistId: PLEX_ID.optional(),
        title: z.string().optional(),
        mediaType: z.enum(["video", "audio"]).default("video"),
        ratingKeys: z.array(PLEX_ID).max(500).default([]),
      },
      handler: async (args) => {
        if (args.action === "create") {
          need(args.title && args.ratingKeys.length, "create needs title and ratingKeys");
          const container = await root.plex("/playlists", {
            title: args.title, type: args.mediaType, smart: 0, uri: await itemUri("manage_playlist", args.ratingKeys),
          }, { method: "POST" });
          const playlist = container.Metadata?.[0];
          return { created: playlist?.title ?? args.title, playlistId: playlist?.ratingKey ?? null, items: args.ratingKeys.length };
        }
        need(args.playlistId, `${args.action} needs playlistId`);
        if (args.action === "add_items") {
          need(args.ratingKeys.length, "add_items needs ratingKeys");
          await root.plex(`/playlists/${args.playlistId}/items`, { uri: await itemUri("manage_playlist", args.ratingKeys) }, { method: "PUT" });
          return { playlistId: args.playlistId, added: args.ratingKeys.length };
        }
        if (args.action === "remove_items") {
          need(args.ratingKeys.length, "remove_items needs ratingKeys");
          const container = await root.plex(`/playlists/${args.playlistId}/items`);
          const wanted = new Set(args.ratingKeys);
          const matched = (container.Metadata ?? []).filter((item) => wanted.has(String(item.ratingKey)));
          // A playlist entry is deleted by its playlistItemID. Plex can leave one
          // out, and an entry without one is reported under skipped.
          const victims: { key: string; id: string }[] = [];
          const skipped: string[] = [];
          for (const item of matched) {
            if (item.playlistItemID === undefined) skipped.push(String(item.ratingKey));
            else victims.push({ key: String(item.ratingKey), id: item.playlistItemID });
          }
          // Plex removes one playlist entry per call, so a failure partway names what already went.
          await eachKey(victims.map((victim) => victim.key), "removed",
            (_key, index) => root.plex(`/playlists/${args.playlistId}/items/${victims[index]!.id}`, {}, { method: "DELETE" }));
          return { playlistId: args.playlistId, removed: victims.length, ...(skipped.length && { skipped }) };
        }
        const container = await root.plex(`/playlists/${args.playlistId}`);
        const playlist = container.Metadata?.[0];
        if (!playlist || playlist.type !== "playlist") throw new Error(`${args.playlistId} is not a playlist. Refusing to delete it.`);
        await root.plex(`/playlists/${args.playlistId}`, {}, { method: "DELETE" });
        return { deleted: playlist.title };
      },
    }),

    manage_collection: defineTool({
      title: "Manage collection",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "Create, extend, prune, or delete a collection in a library. create: " +
        "title + library + ratingKeys (+ kind, which defaults to the kind the " +
        "library holds and must match it). add_items/remove_items: " +
        "collectionId + ratingKeys. delete: collectionId (removes ONLY the " +
        "grouping: its items are untouched). If Plex fails partway through " +
        "remove_items, the error names the keys already removed.",
      inputSchema: {
        action: z.enum(["create", "add_items", "remove_items", "delete"]),
        collectionId: PLEX_ID.optional(),
        title: z.string().optional(),
        library: z.string().optional(),
        kind: z.enum(["movie", "show", "album"]).optional(),
        ratingKeys: z.array(PLEX_ID).max(500).default([]),
      },
      handler: async (args) => {
        if (args.action === "create") {
          need(args.title && args.ratingKeys.length, "create needs title and ratingKeys");
          need(args.library, "create needs library");
          const section = await root.sectionByTitle(args.library);
          // The collection's kind follows the library it goes in. Plex is never
          // asked for a movie collection in a show library.
          const kind = SECTION_COLLECTION_KIND.get(section.type);
          need(kind, `library "${section.title}" (${libraryType(section)}) holds no collection kind this tool offers`);
          need(!args.kind || args.kind === kind, `kind "${args.kind}" does not match library "${section.title}" (${libraryType(section)}), which holds ${kind} collections`);
          const container = await root.plex("/library/collections", {
            type: KIND_TYPE[kind], title: args.title, smart: 0, sectionId: section.key,
            uri: await itemUri("manage_collection", args.ratingKeys),
          }, { method: "POST" });
          const collection = container.Metadata?.[0];
          return { created: collection?.title ?? args.title, collectionId: collection?.ratingKey ?? null, items: args.ratingKeys.length };
        }
        need(args.collectionId, `${args.action} needs collectionId`);
        if (args.action === "add_items") {
          need(args.ratingKeys.length, "add_items needs ratingKeys");
          await root.plex(`/library/collections/${args.collectionId}/items`, { uri: await itemUri("manage_collection", args.ratingKeys) }, { method: "PUT" });
          return { collectionId: args.collectionId, added: args.ratingKeys.length };
        }
        if (args.action === "remove_items") {
          need(args.ratingKeys.length, "remove_items needs ratingKeys");
          // Only remove keys actually in the collection, and report the true
          // count. Plex accepts a DELETE for a non-member without complaint,
          // so a blind loop would confirm removals that never happened.
          const container = await root.plex(`/library/collections/${args.collectionId}/children`);
          const members = new Set((container.Metadata ?? []).map((item) => String(item.ratingKey)));
          const victims = args.ratingKeys.filter((key) => members.has(String(key)));
          // Plex removes one member per call, so a failure partway names what already went.
          await eachKey(victims, "removed",
            (key) => root.plex(`/library/collections/${args.collectionId}/items/${key}`, {}, { method: "DELETE" }));
          const skipped = args.ratingKeys.filter((key) => !members.has(String(key)));
          return {
            collectionId: args.collectionId,
            removed: victims.length,
            ...(skipped.length && { notInCollection: skipped }),
          };
        }
        const container = await root.plex(`/library/collections/${args.collectionId}`);
        const collection = container.Metadata?.[0];
        if (!collection || collection.type !== "collection") throw new Error(`${args.collectionId} is not a collection. Refusing to delete it.`);
        await root.plex(`/library/collections/${args.collectionId}`, {}, { method: "DELETE" });
        return { deleted: collection.title };
      },
    }),

    manage_watchlist: defineTool({
      title: "Manage watchlist",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Add movies or shows in the library to the server owner's plex.tv " +
        "watchlist, or remove them, by ratingKey. Every key is checked before " +
        "anything is sent: one that is not in a library, is not a movie or show, " +
        "or has no Plex GUID fails the whole call. If plex.tv fails partway, the " +
        "error names the keys already changed.",
      inputSchema: {
        action: z.enum(["add", "remove"]),
        ratingKeys: z.array(PLEX_ID).min(1).max(100),
      },
      handler: async ({ action, ratingKeys }) => {
        const keys = [...new Set(ratingKeys)];
        const found = await fetchItems(root, keys);
        const byKey = new Map(found.map((item) => [String(item.ratingKey), item]));
        const unknown = keys.filter((key) => !byKey.has(key));
        need(!unknown.length, `Not in any library: ${unknown.join(", ")}`);
        const wrongKind = keys.filter((key) => !WATCHLIST_KINDS.has(byKey.get(key)!.type));
        need(!wrongKind.length, `Watchlists hold movies and shows only: ${wrongKind.join(", ")}`);
        // An item matched by a legacy agent, or not matched at all, has no plex.tv identity.
        const noGuid = keys.filter((key) => !byKey.get(key)!.guid?.startsWith("plex://"));
        need(!noGuid.length, `No Plex GUID, so plex.tv can't identify: ${noGuid.join(", ")}`);
        // plex.tv takes one item per call, so a failure partway names what already changed.
        await eachKey(keys, action === "add" ? "added" : "removed", (key) => root.editWatchlist(action, byKey.get(key)!.guid!));
        return { action, items: keys.map((key) => ({ ratingKey: key, title: byKey.get(key)!.title })) };
      },
    }),

    scan_library: defineTool({
      title: "Scan library",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Trigger 'Scan Library Files' for one library so Plex picks up added or " +
        "removed files on disk. Safe: never modifies media files or metadata " +
        "edits, and never re-downloads metadata. Optional path limits the scan " +
        "to one server-side folder (find valid paths via get_item file.paths). " +
        "Scans run async. Poll list_libraries and watch 'refreshing'.",
      inputSchema: {
        library: z.string(),
        path: z.string().optional(),
      },
      handler: async ({ library, path }) => {
        const section = await root.sectionByTitle(library);
        await root.plex(`/library/sections/${section.key}/refresh`, path ? { path } : {});
        return { scanning: section.title, path: path ?? null };
      },
    }),
  };
}
