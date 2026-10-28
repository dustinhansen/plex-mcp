import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackTools } from "#dist/lib/tools-playback.js";
import { buildTools } from "#dist/lib/server.js";
import { makeClient } from "#dist/lib/client.js";
import { installClientId } from "#dist/lib/plextv.js";
import { UpstreamError } from "#dist/lib/upstream.js";
import type { PlexClient, PlexRequestOptions, Query } from "#dist/types/boundaries.js";

type FakeClient = PlexClient & { calls: Array<{ path: string; params: Query; opts: PlexRequestOptions }> };
type PlayItemArgs = Parameters<ReturnType<typeof playbackTools>["play_item"]["handler"]>[0];

const clients = { Server: [
  { name: "Living Room TV", machineIdentifier: "tv-1", product: "Plex for Apple TV", platform: "tvOS", address: "192.0.2.20", port: 32500, protocolCapabilities: "playback,navigation" },
  { name: "Plexamp", machineIdentifier: "amp-1", product: "Plexamp", platform: "macOS", address: "192.0.2.30", port: 32500, protocolCapabilities: "playback" },
] };

// ratingKey 7 is a playlist, which play_item cannot queue, and Plex has no
// item for ratingKey 404. Every other key is a track.
function fake({ machineId = "server-xyz" as string | null, makesQueues = true } = {}) {
  const calls: FakeClient["calls"] = [];
  let queues = 40;
  const answer = (path: string) => {
    if (path === "/clients") return clients;
    if (path === "/library/metadata/7") return { Metadata: [{ title: "Road trip", type: "playlist" }] };
    if (path === "/library/metadata/404") throw new UpstreamError("Plex", 404, path);
    if (path.startsWith("/library/metadata/")) return { Metadata: [{ title: "Song", type: "track" }] };
    if (path === "/playQueues") return makesQueues ? { playQueueID: ++queues } : {};
    return {};
  };
  return {
    calls,
    baseUrl: "http://plex.test:32400",
    machineId: async () => machineId ?? undefined,
    plex: async (path: string, params: Query = {}, opts: PlexRequestOptions = {}) => { calls.push({ path, params, opts }); return answer(path); },
  } as unknown as FakeClient;
}

const playMediaIds = (c: FakeClient) =>
  c.calls.filter((x) => x.path === "/player/playback/playMedia").map((x) => x.params.commandID as number);

test("list_clients maps the /clients listing", async () => {
  const c = fake();
  const r = await playbackTools(c).list_clients.handler({});
  assert.deepEqual(r.clients[0], { name: "Living Room TV", machineIdentifier: "tv-1", product: "Plex for Apple TV", platform: "tvOS", address: "192.0.2.20", port: 32500, capabilities: ["playback", "navigation"] });
});

test("play_item targets the client by name (case-insensitive) or id, sends server identity and offset", async () => {
  const c = fake();
  const t = playbackTools(c);
  const r = await t.play_item.handler({ client: "living room tv", ratingKey: "123", offsetMs: 5000 });
  const call = c.calls.find((x) => x.path === "/player/playback/playMedia")!;
  assert.equal(call.params.key, "/library/metadata/123");
  assert.equal(call.params.machineIdentifier, "server-xyz");
  assert.equal(call.params.address, "plex.test");
  assert.equal(call.params.port, "32400");
  assert.equal(call.params.protocol, "http");
  assert.equal(call.params.offset, 5000);
  assert.equal(call.opts.headers!["X-Plex-Target-Client-Identifier"], "tv-1");
  assert.deepEqual(r, { ok: true, client: "Living Room TV", ratingKey: "123", offsetMs: 5000 });
  await t.play_item.handler({ client: "amp-1", ratingKey: "9" } as PlayItemArgs);
  assert.equal(c.calls.at(-1)!.opts.headers!["X-Plex-Target-Client-Identifier"], "amp-1");
});

test("play_item queues the item and points playMedia at the queue", async () => {
  const c = fake();
  await playbackTools(c).play_item.handler({ client: "amp-1", ratingKey: "123" } as PlayItemArgs);
  const queue = c.calls.find((x) => x.path === "/playQueues")!;
  assert.equal(queue.opts.method, "POST");
  assert.deepEqual(queue.params, { type: "audio", uri: "server://server-xyz/com.plexapp.plugins.library/library/metadata/123" });
  const play = c.calls.find((x) => x.path === "/player/playback/playMedia")!;
  assert.equal(play.params.containerKey, "/playQueues/41");
  assert.equal(play.params.type, "music");
  assert.equal(queue.opts.headers!["X-Plex-Client-Identifier"], installClientId());
  assert.equal(play.opts.headers!["X-Plex-Client-Identifier"], installClientId());
  assert.ok(c.calls.indexOf(queue) < c.calls.indexOf(play));
});

test("play_item refuses an item it cannot queue before sending anything to the client", async () => {
  const c = fake();
  await assert.rejects(playbackTools(c).play_item.handler({ client: "amp-1", ratingKey: "7" } as PlayItemArgs) as Promise<unknown>, /ratingKey 7 is a playlist/);
  assert.ok(!c.calls.some((x) => x.path === "/playQueues" || x.path === "/player/playback/playMedia"));
});

test("play_item names a missing item, a missing queue and a missing server identifier, and sends no play command", async () => {
  const play = (c: FakeClient, ratingKey: string) => playbackTools(c).play_item.handler({ client: "amp-1", ratingKey } as PlayItemArgs) as Promise<unknown>;
  const cases: Array<[FakeClient, string, RegExp]> = [
    [fake(), "404", /No item with ratingKey 404/],
    [fake({ makesQueues: false }), "123", /Plex made no play queue for ratingKey 123/],
    [fake({ machineId: null }), "123", /did not report its machine identifier/],
  ];
  for (const [c, ratingKey, message] of cases) {
    await assert.rejects(play(c, ratingKey), message);
    assert.ok(!c.calls.some((x) => x.path === "/player/playback/playMedia"));
  }
});

test("play_item sends a higher commandID on each command", async () => {
  const c = fake();
  const t = playbackTools(c);
  await t.play_item.handler({ client: "tv-1", ratingKey: "1" } as PlayItemArgs);
  await t.play_item.handler({ client: "tv-1", ratingKey: "2" } as PlayItemArgs);
  const [first, second] = playMediaIds(c);
  assert.equal(second, first + 1);
});

test("play_item keeps commandID rising across tool sets, as HTTP mode builds one per request", async () => {
  const c = fake();
  await playbackTools(c).play_item.handler({ client: "tv-1", ratingKey: "1" } as PlayItemArgs);
  await playbackTools(c).play_item.handler({ client: "tv-1", ratingKey: "2" } as PlayItemArgs);
  const [first, second] = playMediaIds(c);
  assert.ok(second > first, `second commandID ${second} is not above ${first}`);
});

test("play_item: unknown client lists what is available", async () => {
  const c = fake();
  await assert.rejects(playbackTools(c).play_item.handler({ client: "Kitchen", ratingKey: "1" } as PlayItemArgs) as Promise<unknown>, /No client "Kitchen".*Living Room TV.*Plexamp/s);
});

test("buildTools registers playback only when enabled", () => {
  const c = makeClient({ baseUrl: "http://plex.test:32400", token: "t", fetchImpl: async () => { throw new Error("x"); } });
  assert.ok(!("play_item" in buildTools(c)));
  assert.ok("play_item" in buildTools(c, { playback: true }));
  assert.ok("list_clients" in buildTools(c, { playback: true }));
});
