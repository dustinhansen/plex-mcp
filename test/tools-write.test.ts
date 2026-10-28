import { test } from "node:test";
import assert from "node:assert/strict";
import { writeTools } from "#dist/lib/tools-write.js";
import { UpstreamError } from "#dist/lib/upstream.js";
import type { PlexClient, PlexRequestOptions, Query } from "#dist/types/boundaries.js";

type FakeClient = PlexClient & { calls: Array<{ path: string; params: Query; options: PlexRequestOptions }> };
type WriteTools = ReturnType<typeof writeTools>;
type PlaylistArgs = Parameters<WriteTools["manage_playlist"]["handler"]>[0];
type CollectionArgs = Parameters<WriteTools["manage_collection"]["handler"]>[0];

function fakeClient() {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    machineId: async () => "server-1",
    sectionByTitle: async (title: string) => ({ title, key: "7" }),
    plex: async (path: string, params: Query = {}, options: PlexRequestOptions = {}) => {
      calls.push({ path, params, options });
      if (path === "/playlists") return { Metadata: [{ title: "Friday", ratingKey: "90" }] };
      if (path === "/playlists/90/items") return { Metadata: [{ ratingKey: "2", playlistItemID: "200" }] };
      if (path === "/library/collections/12") return { Metadata: [{ type: "collection", title: "Favorites" }] };
      if (path === "/library/collections/13") return { Metadata: [{ type: "movie", title: "Not a collection" }] };
      if (path === "/library/collections/12/children") return { Metadata: [{ ratingKey: "2" }] };
      return {};
    },
  } as unknown as FakeClient;
}

test("write tools address only the named Plex targets and preserve their methods", async () => {
  const c = fakeClient();
  const tools = writeTools(c);

  await tools.set_watched.handler({ ratingKeys: ["1", "2"], watched: true });
  await tools.rate_item.handler({ ratingKey: "3", rating: null });
  assert.deepEqual(c.calls.slice(0, 3), [
    { path: "/:/scrobble", params: { key: "1", identifier: "com.plexapp.plugins.library" }, options: {} },
    { path: "/:/scrobble", params: { key: "2", identifier: "com.plexapp.plugins.library" }, options: {} },
    { path: "/:/rate", params: { key: "3", identifier: "com.plexapp.plugins.library", rating: -1 }, options: {} },
  ]);

  assert.deepEqual(await tools.manage_playlist.handler({ action: "create", title: "Friday", mediaType: "video", ratingKeys: ["1", "2"] }), { created: "Friday", playlistId: "90", items: 2 });
  assert.deepEqual(c.calls.at(-1), {
    path: "/playlists",
    params: { title: "Friday", type: "video", smart: 0, uri: "server://server-1/com.plexapp.plugins.library/library/metadata/1,2" },
    options: { method: "POST" },
  });

  await tools.manage_playlist.handler({ action: "add_items", playlistId: "90", ratingKeys: ["2"] } as PlaylistArgs);
  assert.deepEqual(c.calls.at(-1), {
    path: "/playlists/90/items",
    params: { uri: "server://server-1/com.plexapp.plugins.library/library/metadata/2" },
    options: { method: "PUT" },
  });
  await tools.manage_playlist.handler({ action: "remove_items", playlistId: "90", ratingKeys: ["2", "missing"] } as PlaylistArgs);
  assert.deepEqual(c.calls.slice(-2), [
    { path: "/playlists/90/items", params: {}, options: {} },
    { path: "/playlists/90/items/200", params: {}, options: { method: "DELETE" } },
  ]);

  assert.deepEqual(await tools.manage_collection.handler({ action: "delete", collectionId: "12" } as CollectionArgs), { deleted: "Favorites" });
  assert.deepEqual(c.calls.slice(-2), [
    { path: "/library/collections/12", params: {}, options: {} },
    { path: "/library/collections/12", params: {}, options: { method: "DELETE" } },
  ]);
  await assert.rejects(tools.manage_collection.handler({ action: "delete", collectionId: "13" } as CollectionArgs) as Promise<unknown>, /not a collection/);

  await tools.manage_collection.handler({ action: "add_items", collectionId: "12", ratingKeys: ["2"] });
  assert.deepEqual(c.calls.at(-1), {
    path: "/library/collections/12/items",
    params: { uri: "server://server-1/com.plexapp.plugins.library/library/metadata/2" },
    options: { method: "PUT" },
  });
  assert.deepEqual(await tools.manage_collection.handler({ action: "remove_items", collectionId: "12", ratingKeys: ["2", "missing"] }), {
    collectionId: "12", removed: 1, notInCollection: ["missing"],
  });
  assert.deepEqual(c.calls.slice(-2), [
    { path: "/library/collections/12/children", params: {}, options: {} },
    { path: "/library/collections/12/items/2", params: {}, options: { method: "DELETE" } },
  ]);
});

/** A client whose plex call fails on the given request, counting from 1. */
function failingOn(request: number) {
  const c = fakeClient();
  c.plex = async (path: string, params: Query = {}, options: PlexRequestOptions = {}) => {
    c.calls.push({ path, params, options });
    if (c.calls.length === request) throw new Error(`Plex 500 on ${path}`);
    return {};
  };
  return c;
}

test("set_watched failing partway names the keys already marked", async () => {
  const c = failingOn(2);
  await assert.rejects(async () => writeTools(c).set_watched.handler({ ratingKeys: ["1", "2", "3"], watched: true }),
    (e: Error) => e.message === "Plex 500 on /:/scrobble. Already marked watched: 1.");
  assert.equal(c.calls.length, 2);
});

test("set_watched failing on the first key says nothing was changed", async () => {
  const c = failingOn(1);
  await assert.rejects(async () => writeTools(c).set_watched.handler({ ratingKeys: ["1", "2"], watched: false }),
    (e: Error) => e.message === "Plex 500 on /:/unscrobble. Nothing was changed.");
  assert.equal(c.calls.length, 1);
});

test("set_watched failing with a non-Error still names the failure", async () => {
  const c = fakeClient();
  c.plex = async () => { throw "socket hang up"; };
  await assert.rejects(async () => writeTools(c).set_watched.handler({ ratingKeys: ["1"], watched: true }),
    (e: Error) => e.message === "socket hang up. Nothing was changed.");
});

/** A client whose listings hold keys 1, 2 and 3, and whose DELETE fails on the
 *  given one, counting from 1. */
function deleteFailingOn(request: number) {
  const c = fakeClient();
  let deletes = 0;
  c.plex = async (path: string, params: Query = {}, options: PlexRequestOptions = {}) => {
    c.calls.push({ path, params, options });
    if (options.method === "DELETE" && ++deletes === request) throw new Error(`Plex 500 on ${path}`);
    if (path === "/playlists/90/items") return { Metadata: ["1", "2", "3"].map((key) => ({ ratingKey: key, title: `Item ${key}`, type: "movie", playlistItemID: `${key}00` })) };
    if (path === "/library/collections/12/children") return { Metadata: ["1", "2", "3"].map((key) => ({ ratingKey: key, title: `Item ${key}`, type: "movie" })) };
    return {};
  };
  return c;
}

test("manage_playlist remove_items failing partway names the keys already removed", async () => {
  const c = deleteFailingOn(2);
  await assert.rejects(async () => writeTools(c).manage_playlist.handler({ action: "remove_items", playlistId: "90", ratingKeys: ["1", "2", "3"] } as PlaylistArgs),
    (e: Error) => e.message === "Plex 500 on /playlists/90/items/200. Already removed: 1.");
  assert.equal(c.calls.length, 3);
});

test("manage_playlist remove_items failing on the first delete says nothing was changed", async () => {
  const c = deleteFailingOn(1);
  await assert.rejects(async () => writeTools(c).manage_playlist.handler({ action: "remove_items", playlistId: "90", ratingKeys: ["1", "2", "3"] } as PlaylistArgs),
    (e: Error) => e.message === "Plex 500 on /playlists/90/items/100. Nothing was changed.");
  assert.equal(c.calls.length, 2);
});

test("manage_collection remove_items failing partway names the keys already removed", async () => {
  const c = deleteFailingOn(2);
  await assert.rejects(async () => writeTools(c).manage_collection.handler({ action: "remove_items", collectionId: "12", ratingKeys: ["1", "2", "3"] } as CollectionArgs),
    (e: Error) => e.message === "Plex 500 on /library/collections/12/items/2. Already removed: 1.");
  assert.equal(c.calls.length, 3);
});

test("manage_collection remove_items failing on the first delete says nothing was changed", async () => {
  const c = deleteFailingOn(1);
  await assert.rejects(async () => writeTools(c).manage_collection.handler({ action: "remove_items", collectionId: "12", ratingKeys: ["1", "2", "3"] } as CollectionArgs),
    (e: Error) => e.message === "Plex 500 on /library/collections/12/items/1. Nothing was changed.");
  assert.equal(c.calls.length, 2);
});

test("manage_collection create writes only into the library it names", async () => {
  const c = fakeClient();
  const resolved: string[] = [];
  c.sectionByTitle = async (title: string) => { resolved.push(title); return { title, key: title === "TV Shows" ? "4" : "7", type: title === "TV Shows" ? "show" : "movie" }; };
  const tools = writeTools(c);

  await assert.rejects(tools.manage_collection.handler({ action: "create", title: "Arrival", kind: "movie", ratingKeys: ["1"] }) as Promise<unknown>, /create needs library/);
  assert.deepEqual(resolved, []);
  assert.deepEqual(c.calls, []);

  assert.deepEqual(await tools.manage_collection.handler({ action: "create", title: "Slow TV", library: "TV Shows", kind: "show", ratingKeys: ["5"] }), { created: "Slow TV", collectionId: null, items: 1 });
  assert.deepEqual(resolved, ["TV Shows"]);
  assert.deepEqual(c.calls.at(-1), {
    path: "/library/collections",
    params: { type: 2, title: "Slow TV", smart: 0, sectionId: "4", uri: "server://server-1/com.plexapp.plugins.library/library/metadata/5" },
    options: { method: "POST" },
  });
});

test("manage_collection create takes its kind from the named library's type", async () => {
  const c = fakeClient();
  const libraries: Record<string, { key: string; type: string }> = { Movies: { key: "1", type: "movie" }, "TV Shows": { key: "4", type: "show" }, Music: { key: "6", type: "artist" }, Photos: { key: "9", type: "photo" } };
  c.sectionByTitle = async (title: string) => ({ title, ...libraries[title] });
  const tools = writeTools(c);
  const create = (library: string, extra: Partial<CollectionArgs> = {}) => tools.manage_collection.handler({ action: "create", title: "Picks", library, ratingKeys: ["5"], ...extra }) as Promise<unknown>;

  for (const [library, type, sectionId] of [["Movies", 1, "1"], ["TV Shows", 2, "4"], ["Music", 9, "6"]] as const) {
    await create(library);
    assert.deepEqual(c.calls.at(-1)!.params, { type, title: "Picks", smart: 0, sectionId, uri: "server://server-1/com.plexapp.plugins.library/library/metadata/5" });
  }
  // A kind that agrees with the library is accepted as given.
  await create("TV Shows", { kind: "show" });
  assert.equal(c.calls.at(-1)!.params.type, 2);

  const posts = c.calls.length;
  await assert.rejects(create("TV Shows", { kind: "movie" }), /kind "movie".*"TV Shows" \(TV Shows\).*show collections/);
  await assert.rejects(create("Music", { kind: "show" }), /kind "show".*"Music" \(Music\).*album collections/);
  await assert.rejects(create("Photos"), /"Photos" \(Photos\) holds no collection kind/);
  await assert.rejects(create("Photos", { kind: "movie" }), /"Photos" \(Photos\) holds no collection kind/);
  assert.equal(c.calls.length, posts);
});

test("playlist and collection writes refuse, sending nothing, when Plex reports no machine identifier", async () => {
  const c = fakeClient();
  c.machineId = async () => undefined;
  c.sectionByTitle = async (title: string) => ({ title, key: "1", type: "movie" });
  const tools = writeTools(c);
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["manage_playlist", () => tools.manage_playlist.handler({ action: "create", title: "Friday", mediaType: "video", ratingKeys: ["1"] }) as Promise<unknown>],
    ["manage_playlist", () => tools.manage_playlist.handler({ action: "add_items", playlistId: "90", mediaType: "video", ratingKeys: ["1"] }) as Promise<unknown>],
    ["manage_collection", () => tools.manage_collection.handler({ action: "create", title: "Picks", library: "Movies", ratingKeys: ["1"] }) as Promise<unknown>],
    ["manage_collection", () => tools.manage_collection.handler({ action: "add_items", collectionId: "12", ratingKeys: ["1"] }) as Promise<unknown>],
  ];
  for (const [tool, write] of writes) {
    await assert.rejects(write(), (e: Error) => e.message === `The Plex server did not report its machine identifier, which ${tool} needs to name the items it adds.`);
  }
  assert.deepEqual(c.calls, []);
});

test("manage_watchlist: a 404 for every key reads as not in any library, and a plain Error is rethrown", async () => {
  let failure: Error = new UpstreamError("Plex", 404, "metadata lookup");
  const c = { ...fakeClient(), plex: async () => { throw failure; } } as unknown as PlexClient;
  await assert.rejects(writeTools(c).manage_watchlist.handler({ action: "add", ratingKeys: ["98", "99"] }) as Promise<unknown>, (e: Error) => e.message === "Not in any library: 98, 99");
  failure = new Error("Plex 404 on /library/metadata/98,99");
  await assert.rejects(writeTools(c).manage_watchlist.handler({ action: "add", ratingKeys: ["98", "99"] }) as Promise<unknown>, (e: Error) => e === failure);
});
