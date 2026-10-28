/** Play-to-client. Registered only with PLEX_ALLOW_PLAYBACK=1, and never with
 *  PLEX_READ_ONLY=1: it is the one tool family here that acts on the physical
 *  world. */
import { z } from "zod";
import { defineTool, PLEX_ID, READ_ONLY } from "../types/tool-registration.js";
import { installClientId } from "./plextv.js";
import { libraryItemUri } from "./filters.js";
import { isNotFound } from "./upstream.js";
import type { PlexClient, PlexPlayer } from "../types/boundaries.js";

// Plex names a play queue's media "audio" and the player command's "music".
const VIDEO = { queue: "video", player: "video" };
const AUDIO = { queue: "audio", player: "music" };
const PLAY_TYPES = new Map([
  ["movie", VIDEO], ["show", VIDEO], ["season", VIDEO], ["episode", VIDEO], ["clip", VIDEO],
  ["artist", AUDIO], ["album", AUDIO], ["track", AUDIO],
  ["photo", { queue: "photo", player: "photo" }],
]);

const clientDict = (player: PlexPlayer) => ({
  name: player.name,
  machineIdentifier: player.machineIdentifier,
  product: player.product ?? null,
  platform: player.platform ?? null,
  address: player.address ?? null,
  port: player.port ?? null,
  capabilities: (player.protocolCapabilities ?? "").split(",").filter(Boolean),
});

// The player API expects each command from a controller to carry a higher id
// than the last, and a player may ignore one it has already seen. The counter
// lives at module level because HTTP mode builds a tool set per request, and
// every tool set in the process has to continue one sequence.
let commandID = 0;

export function playbackTools(root: PlexClient) {
  async function clients() {
    return ((await root.plex("/clients")).Server ?? []).map(clientDict);
  }

  // Plex refuses a play queue (400) from a request that names no client, and
  // the player API expects every command to name its controller.
  const controller = { "X-Plex-Client-Identifier": installClientId() };

  return {
    list_clients: defineTool({
      title: "List clients",
      annotations: READ_ONLY,
      description:
        "Plex players currently reachable by the server, such as Plexamp. These are the " +
        "targets for play_item. Apps must be open to appear, and current Plex TV " +
        "and desktop apps may not appear at all.",
      inputSchema: {},
      handler: async () => ({ clients: await clients() }),
    }),

    play_item: defineTool({
      title: "Play item",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Start playing an item (movie, episode, track, album…) on a Plex client " +
        "from list_clients, by client name or machineIdentifier. offsetMs resumes " +
        "part-way in. Requires PLEX_ALLOW_PLAYBACK=1 on the server.",
      inputSchema: {
        client: z.string().describe("client name or machineIdentifier"),
        ratingKey: PLEX_ID,
        offsetMs: z.number().int().min(0).default(0),
      },
      handler: async ({ client, ratingKey, offsetMs }) => {
        const all = await clients();
        const name = client.toLowerCase();
        const target = all.find((player) => player.machineIdentifier === client) ?? all.find((player) => player.name.toLowerCase() === name);
        if (!target) {
          throw new Error(`No client "${client}". Available: ${all.map((player) => player.name).join(", ") || "none (open a Plex app first)"}`);
        }
        const key = `/library/metadata/${ratingKey}`;
        const noItem = () => new Error(`No item with ratingKey ${ratingKey}`);
        // Plex answers 404 for a ratingKey it has nothing for.
        const item = (await root.plex(key).catch((error) => {
          throw isNotFound(error) ? noItem() : error;
        })).Metadata?.[0];
        if (!item) throw noItem();
        const media = PLAY_TYPES.get(item.type);
        if (!media) throw new Error(`ratingKey ${ratingKey} is a ${item.type}, which play_item cannot play`);
        const machineIdentifier = await root.machineId();
        if (!machineIdentifier) throw new Error("The Plex server did not report its machine identifier, which play_item needs to name the item to the player.");
        // A player answers 200 to playMedia without a play queue and then
        // plays nothing, so the item goes into a queue first.
        const queue = await root.plex("/playQueues", {
          type: media.queue,
          uri: libraryItemUri(machineIdentifier, [ratingKey]),
        }, { method: "POST", headers: controller });
        if (queue.playQueueID === undefined) throw new Error(`Plex made no play queue for ratingKey ${ratingKey}`);
        const server = new URL(root.baseUrl);
        await root.plex(
          "/player/playback/playMedia",
          {
            key,
            containerKey: `/playQueues/${queue.playQueueID}`,
            type: media.player,
            offset: offsetMs,
            machineIdentifier,
            address: server.hostname,
            port: server.port || (server.protocol === "https:" ? "443" : "80"),
            protocol: server.protocol.replace(":", ""),
            commandID: ++commandID,
          },
          { headers: { ...controller, "X-Plex-Target-Client-Identifier": target.machineIdentifier } }
        );
        return { ok: true, client: target.name, ratingKey, offsetMs };
      },
    }),
  };
}
