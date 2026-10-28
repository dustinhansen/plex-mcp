import { test } from "node:test";
import assert from "node:assert/strict";
import { project } from "#dist/lib/format.js";
import { makeClient } from "#dist/lib/client.js";
import { fetchItems, readTools, withCollections } from "#dist/lib/tools-read.js";
import { UpstreamError } from "#dist/lib/upstream.js";
import type { PlexClient, PlexMediaContainer, PlexRequestOptions, Query } from "#dist/types/boundaries.js";

type ListMediaArgs = Parameters<ReturnType<typeof readTools>["list_media"]["handler"]>[0];

test("project: keeps only requested keys, ratingKey always present, unknown keys ignored", () => {
  const item = { title: "A", ratingKey: "1", year: 2000, watched: false };
  assert.deepEqual(project(item, ["title", "nope"]), { ratingKey: "1", title: "A" });
  assert.deepEqual(project(item, undefined), item);
  assert.deepEqual(project(item, []), item);
});

test("project: copies only the record's own keys, never inherited ones", () => {
  const item = Object.assign(Object.create({ inherited: true }), { title: "A", ratingKey: "1" });
  const output = project(item, ["constructor", "__proto__", "title"]);
  assert.deepEqual(Object.getOwnPropertyNames(output), ["ratingKey", "title"]);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.deepEqual(output, { ratingKey: "1", title: "A" });
});

const fakeClient = (pages: Record<number, PlexMediaContainer>) => ({
  as: async function (u?: string | null) { return this; },
  sectionByTitle: async () => ({ key: "1", type: "movie", title: "Movies" }),
  resolveSectionTag: async () => { throw new Error("unused"); },
  plex: async (_path: string, _params: Query, { start }: PlexRequestOptions) => pages[start!],
}) as unknown as PlexClient;

test("list_media: nextOffset advances while more remain, null when exhausted; fields projects", async () => {
  const meta = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `M${i}`, type: "movie", ratingKey: String(i), year: 1999 }));
  const t = readTools(fakeClient({ 0: { totalSize: 7, Metadata: meta(5) }, 5: { totalSize: 7, Metadata: meta(2) } }));
  const p1 = await t.list_media.handler({ library: "Movies", watched: "all", rated: "all", offset: 0, limit: 5, detail: false, fields: ["title"] } as ListMediaArgs);
  assert.equal(p1.nextOffset, 5);
  assert.deepEqual(p1.items[0], { ratingKey: "0", title: "M0" });
  const p2 = await t.list_media.handler({ library: "Movies", watched: "all", rated: "all", offset: 5, limit: 5, detail: false } as ListMediaArgs);
  assert.equal(p2.nextOffset, null);
  assert.equal(p2.items[0].watched, false); // full record when fields absent
});

test("list_media: studio filters by the studio's name, other tag filters by tag id", async () => {
  // Plex's /studio listing keys each studio by its name URL-encoded twice
  const tags: Record<string, { id: string; name: string }> = {
    studio: { id: "1440%2520Productions", name: "1440 Productions" },
    country: { id: "130338", name: "Australia" },
  };
  let sent: Query = {};
  const c = {
    ...fakeClient({}),
    resolveSectionTag: async (_key: string, tagType: string) => tags[tagType],
    plex: async (_path: string, params: Query) => { sent = params; return { totalSize: 0, Metadata: [] }; },
  } as unknown as PlexClient;
  await readTools(c).list_media.handler({ library: "Movies", watched: "all", rated: "all", studio: "1440 productions", country: "australia", offset: 0, limit: 5, detail: false } as ListMediaArgs);
  assert.equal(sent.studio, "1440 Productions");
  assert.equal(sent.country, "130338");
});

test("list_media detail: collections come from the items' full metadata, which the section listing leaves out", async () => {
  const paths: string[] = [];
  const c = {
    ...fakeClient({}),
    plex: async (path: string) => {
      paths.push(path);
      if (path === "/library/sections/1/all") return { totalSize: 2, Metadata: [{ ratingKey: "7", type: "movie", title: "A" }, { ratingKey: "8", type: "movie", title: "B" }] };
      return { Metadata: [{ ratingKey: "8", type: "movie", Collection: [{ tag: "Pair" }] }, { ratingKey: "7", type: "movie", Collection: [{ tag: "Pair" }, { tag: "Criterion" }] }] };
    },
  } as unknown as PlexClient;
  const t = readTools(c);
  const out = await t.list_media.handler({ library: "Movies", watched: "all", rated: "all", offset: 0, limit: 5, detail: true } as ListMediaArgs);
  assert.deepEqual(out.items.map((i) => i.collections), [["Pair", "Criterion"], ["Pair"]]);
  assert.deepEqual(paths, ["/library/sections/1/all", "/library/metadata/7,8"]);

  paths.length = 0;
  await t.list_media.handler({ library: "Movies", watched: "all", rated: "all", offset: 0, limit: 5, detail: false } as ListMediaArgs);
  assert.deepEqual(paths, ["/library/sections/1/all"]);
});

test("list_media detail: an empty page makes no metadata request, a 404 for the whole batch keeps the listing's records, other errors fail", async () => {
  const paths: string[] = [];
  let listing: PlexMediaContainer = { totalSize: 0, Metadata: [] };
  let status = 404;
  let plain = false;
  const c = {
    ...fakeClient({}),
    plex: async (path: string) => {
      paths.push(path);
      if (path === "/library/sections/1/all") return listing;
      // the message is not the real one, so only the status can tell a 404
      if (status === 404 && !plain) throw new UpstreamError("Plex", 404, "metadata lookup");
      throw new Error(`Plex ${status} on ${path}`);
    },
  } as unknown as PlexClient;
  const t = readTools(c);
  const args = { library: "Movies", watched: "all", rated: "all", offset: 0, limit: 5, detail: true } as ListMediaArgs;
  assert.equal((await t.list_media.handler(args)).returned, 0);
  assert.deepEqual(paths, ["/library/sections/1/all"]);

  listing = { totalSize: 1, Metadata: [{ ratingKey: "7", type: "movie", title: "A", Collection: [{ tag: "Pair" }] }] };
  const out = await t.list_media.handler(args);
  assert.deepEqual(out.items.map((i) => i.collections), [["Pair"]]);
  assert.equal(paths.at(-1), "/library/metadata/7");

  status = 500;
  await assert.rejects(t.list_media.handler(args) as Promise<unknown>, /Plex 500/);
  // a plain Error that only says 404 is not a 404
  status = 404;
  plain = true;
  await assert.rejects(t.list_media.handler(args) as Promise<unknown>, /Plex 404/);
});

/** A client whose listings name no collections, while /library/metadata names them all. */
const collectionsClient = (listing: PlexMediaContainer, paths: string[]) => ({
  ...fakeClient({}),
  resolvePerson: async () => ({ id: "55", name: "Denis Villeneuve" }),
  plex: async (path: string) => {
    paths.push(path);
    if (!path.startsWith("/library/metadata/") || path.endsWith("/children")) return listing;
    const keys = path.slice("/library/metadata/".length).split(",");
    return { Metadata: keys.map((k) => ({ ratingKey: k, type: "movie", Collection: [{ tag: `Set ${k}` }] })) };
  },
}) as unknown as PlexClient;
const LISTING = { totalSize: 2, Metadata: [{ ratingKey: "7", type: "movie", title: "A" }, { ratingKey: "8", type: "movie", title: "B" }] };

test("library_changes detail: each bucket's collections come from the items' full metadata", async () => {
  const paths: string[] = [];
  const t = readTools(collectionsClient(LISTING, paths));
  const out = await t.library_changes.handler({ library: "Movies", since: "-7d", limit: 5, detail: true });
  assert.deepEqual(out.added.items.map((i) => (i as Record<string, unknown>).collections), [["Set 7"], ["Set 8"]]);
  assert.deepEqual(out.updated.items.map((i) => (i as Record<string, unknown>).collections), [["Set 7"], ["Set 8"]]);
  assert.deepEqual(paths, ["/library/sections/1/all", "/library/metadata/7,8", "/library/sections/1/all", "/library/metadata/7,8"]);

  paths.length = 0;
  await t.library_changes.handler({ library: "Movies", since: "-7d", limit: 5, detail: false });
  assert.deepEqual(paths, ["/library/sections/1/all", "/library/sections/1/all"]);
});

test("get_children detail: collections come from the items' full metadata, for a container and a playlist", async () => {
  const paths: string[] = [];
  const t = readTools(collectionsClient(LISTING, paths));
  for (const [ratingKey, playlist, path] of [["20", false, "/library/metadata/20/children"], ["90", true, "/playlists/90/items"]] as const) {
    paths.length = 0;
    const out = await t.get_children.handler({ ratingKey, playlist, offset: 0, limit: 5, detail: true });
    assert.deepEqual(out.items.map((i) => i.collections), [["Set 7"], ["Set 8"]]);
    assert.deepEqual(paths, [path, "/library/metadata/7,8"]);

    paths.length = 0;
    await t.get_children.handler({ ratingKey, playlist, offset: 0, limit: 5, detail: false });
    assert.deepEqual(paths, [path]);
  }
});

test("person_credits: a 404 from the writer index names the library, and any other failure is rethrown", async () => {
  let failure: Error = new UpstreamError("Plex", 404, "tag lookup");
  const c = { ...fakeClient({}), resolveSectionTag: async () => { throw failure; } } as unknown as PlexClient;
  const args = { name: "sorkin", role: "writer", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 5, detail: false } as const;
  await assert.rejects(readTools(c).person_credits.handler(args) as Promise<unknown>, (e: Error) => e.message === 'Library "Movies" has no writer index on this Plex server.');
  failure = new Error("Plex 404 on /library/sections/1/writer");
  await assert.rejects(readTools(c).person_credits.handler(args) as Promise<unknown>, (e: Error) => e === failure);
});

test("person_credits detail: collections come from the items' full metadata", async () => {
  const paths: string[] = [];
  const t = readTools(collectionsClient(LISTING, paths));
  const args = { name: "villeneuve", role: "director", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 5 } as const;
  const out = await t.person_credits.handler({ ...args, detail: true });
  assert.deepEqual(out.items.map((i) => i.collections), [["Set 7"], ["Set 8"]]);
  assert.deepEqual(paths, ["/library/sections/1/all", "/library/metadata/7,8"]);

  paths.length = 0;
  await t.person_credits.handler({ ...args, detail: false });
  assert.deepEqual(paths, ["/library/sections/1/all"]);
});

test("person_credits: fields projects each record, and person and role stay on the response", async () => {
  const t = readTools(collectionsClient(LISTING, []));
  const args = { name: "villeneuve", role: "director", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 5, detail: false } as const;
  const out = await t.person_credits.handler({ ...args, fields: ["title"] });
  assert.deepEqual(out.items, [{ ratingKey: "7", title: "A" }, { ratingKey: "8", title: "B" }]);
  assert.equal(out.person, "Denis Villeneuve");
  assert.equal(out.role, "director");
});

test("fetchItems: 1 request for every key, a 404 comes back as no items, any other failure is rethrown", async () => {
  const paths: string[] = [];
  let failure: Error | null = null;
  const client = {
    plex: async (path: string) => {
      paths.push(path);
      if (failure) throw failure;
      return { Metadata: [{ ratingKey: "7", type: "movie", title: "A" }] };
    },
  } as unknown as PlexClient;
  assert.deepEqual(await fetchItems(client, ["7", "8"]), [{ ratingKey: "7", type: "movie", title: "A" }]);
  assert.deepEqual(paths, ["/library/metadata/7,8"]);

  failure = new UpstreamError("Plex", 404, "metadata lookup");
  assert.deepEqual(await fetchItems(client, ["8"]), []);

  failure = new UpstreamError("Plex", 500, "metadata lookup");
  await assert.rejects(fetchItems(client, ["8"]), (error) => error === failure);
  // a plain Error that only says 404 is not a 404
  failure = new Error("Plex 404 on /library/metadata/8");
  await assert.rejects(fetchItems(client, ["8"]), (error) => error === failure);
});

/** The real client over Plex-shaped bodies keyed by pathname. Every path asked for is recorded. */
function plexServer(routes: Record<string, unknown>) {
  const paths: string[] = [];
  const fetchImpl = async (url: URL) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body = routes[u.pathname];
    if (body === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: body }) };
  };
  return { paths, client: makeClient({ baseUrl: "http://plex.test:32400", token: "tok", fetchImpl }) };
}

test("withCollections: an item with no ratingKey stays out of the metadata request", async () => {
  const { paths, client } = plexServer({
    "/library/sections/1/all": { size: 2, Metadata: [{ ratingKey: "7", type: "movie", title: "A" }, { type: "movie", title: "B" }] },
    "/library/metadata/7": { size: 1, Metadata: [{ ratingKey: "7", type: "movie", title: "A", Collection: [{ tag: "Classics" }] }] },
  });
  const listing = await client.plex("/library/sections/1/all");
  const out = await withCollections(client, listing);
  assert.deepEqual(paths, ["/library/sections/1/all", "/library/metadata/7"]);
  assert.deepEqual(out.Metadata?.map((item) => item.Collection), [[{ tag: "Classics" }], undefined]);
});

test("withCollections: a listing with no ratingKeys sends no metadata request and comes back unchanged", async () => {
  const { paths, client } = plexServer({
    "/library/sections/1/all": { size: 2, Metadata: [{ type: "movie", title: "A" }, { type: "movie", title: "B" }] },
  });
  const listing = await client.plex("/library/sections/1/all");
  assert.equal(await withCollections(client, listing), listing);
  assert.deepEqual(paths, ["/library/sections/1/all"]);
});
