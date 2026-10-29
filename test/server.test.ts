import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TextContent, TextResourceContents, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, buildTools, MAX_TOOL_INPUT_ELEMENTS } from "#dist/lib/server.js";
import { DETAIL_CAP, DETAIL_FIELDS_PHRASE } from "#dist/lib/tools-read.js";
import { makeClient } from "#dist/lib/client.js";
import { makeTautulli } from "#dist/lib/tautulli.js";
import type { FetchLike, PlexClient } from "#dist/types/boundaries.js";

type ServerOptions = Parameters<typeof buildServer>[1];

const require_ = createRequire(import.meta.url);
const pkg: { name: string; version: string; mcpName: string; bin: Record<string, string>; main?: string; exports?: unknown } = require_("../package.json");
const indexPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const noNetwork: FetchLike = async () => { throw new Error("no network in unit tests"); };
const testClient = (fetchImpl: FetchLike = noNetwork) => makeClient({ baseUrl: "http://plex.test:32400", token: "tok", fetchImpl });

async function protocol(options: ServerOptions = {}, fetchImpl: FetchLike = noNetwork, plexClient: PlexClient = testClient(fetchImpl)) {
  const { server } = buildServer(plexClient, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "compatibility-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const BASE_TOOLS = [
  "list_libraries", "list_media", "library_changes", "search", "get_item", "get_extras", "get_children", "person_credits", "library_stats", "similar_items", "random_pick", "get_watchlist", "continue_watching", "watch_history", "now_playing", "list_users", "set_watched", "rate_item", "manage_playlist", "manage_collection", "manage_watchlist", "scan_library",
];

// This is deliberately a protocol-level contract, rather than a view of the
// SDK's private registration objects. The implementation may change, but
// clients must keep seeing this exact surface.
const schema = (properties: string[], required: string[] = [], defaults: Record<string, unknown> = {}) => ({ properties, required, defaults });
const SCHEMA_CONTRACT: Record<string, ReturnType<typeof schema>> = {
  list_libraries: schema([]),
  list_media: schema(["library", "kind", "watched", "rated", "genre", "year", "decade", "contentRating", "collection", "country", "studio", "maxDurationMin", "addedSince", "lastViewedBefore", "lastViewedAfter", "sort", "order", "user", "offset", "limit", "detail", "fields"], [], { library: "Movies", watched: "all", rated: "all", sort: "addedAt", order: "desc", offset: 0, limit: 100, detail: false }),
  library_changes: schema(["library", "since", "kind", "limit", "detail"], [], { library: "Movies", since: "-7d", limit: 100, detail: false }),
  search: schema(["query", "externalId", "limit"], [], { limit: 20 }),
  get_item: schema(["ratingKey"], ["ratingKey"]), get_extras: schema(["ratingKey"], ["ratingKey"]),
  get_children: schema(["ratingKey", "playlist", "offset", "limit", "detail", "fields"], ["ratingKey"], { playlist: false, offset: 0, limit: 100, detail: false }),
  person_credits: schema(["name", "role", "library", "watched", "sort", "order", "offset", "limit", "detail", "fields"], ["name"], { role: "director", library: "Movies", watched: "all", sort: "year", order: "asc", offset: 0, limit: 100, detail: false }),
  library_stats: schema(["library", "includeUserStats", "user"], [], { library: "Movies", includeUserStats: false }),
  similar_items: schema(["ratingKey", "watched", "limit"], ["ratingKey"], { watched: "all", limit: 10 }),
  random_pick: schema(["library", "kind", "watched", "rated", "genre", "year", "decade", "contentRating", "collection", "country", "studio", "maxDurationMin", "addedSince", "lastViewedBefore", "lastViewedAfter", "count", "detail", "user"], [], { library: "Movies", watched: "all", rated: "all", count: 3, detail: false }),
  get_watchlist: schema(["offset", "limit"], [], { offset: 0, limit: 50 }),
  continue_watching: schema(["library", "user", "limit", "detail"], [], { limit: 20, detail: false }),
  watch_history: schema(["user", "library", "kind", "since", "until", "ratingKey", "offset", "limit"], [], { offset: 0, limit: 50 }),
  now_playing: schema([]), list_users: schema([]),
  set_watched: schema(["ratingKeys", "watched"], ["ratingKeys", "watched"]),
  rate_item: schema(["ratingKey", "rating"], ["ratingKey", "rating"]),
  manage_playlist: schema(["action", "playlistId", "title", "mediaType", "ratingKeys"], ["action"], { mediaType: "video", ratingKeys: [] }),
  manage_collection: schema(["action", "collectionId", "title", "library", "kind", "ratingKeys"], ["action"], { ratingKeys: [] }),
  manage_watchlist: schema(["action", "ratingKeys"], ["action", "ratingKeys"]),
  scan_library: schema(["library", "path"], ["library"]),
  list_clients: schema([]),
  play_item: schema(["client", "ratingKey", "offsetMs"], ["client", "ratingKey"], { offsetMs: 0 }),
  tautulli_stats: schema(["days", "count"], [], { days: 30, count: 10 }),
  tautulli_history: schema(["user", "ratingKey", "days", "limit"], [], { days: 30, limit: 50 }),
};

const KINDS = ["movie", "show", "season", "episode", "artist", "album", "track", "collection"];
const ENUMS: Record<string, string[]> = {
  "list_media.kind": KINDS, "library_changes.kind": ["movie", "show", "season", "episode", "artist", "album", "track"], "random_pick.kind": KINDS,
  "list_media.watched": ["all", "watched", "unwatched"], "person_credits.watched": ["all", "watched", "unwatched"], "similar_items.watched": ["all", "watched", "unwatched"], "random_pick.watched": ["all", "watched", "unwatched"],
  "list_media.rated": ["all", "rated", "unrated"], "random_pick.rated": ["all", "rated", "unrated"],
  "list_media.sort": ["title", "year", "rating", "audienceRating", "userRating", "addedAt", "lastViewedAt", "viewCount", "duration", "random"],
  "person_credits.sort": ["title", "year", "rating", "audienceRating", "userRating", "addedAt", "lastViewedAt", "viewCount", "duration", "random"],
  "list_media.order": ["asc", "desc"], "person_credits.order": ["asc", "desc"],
  "person_credits.role": ["director", "actor", "writer", "composer"],
  "manage_playlist.action": ["create", "add_items", "remove_items", "delete"], "manage_collection.action": ["create", "add_items", "remove_items", "delete"],
  "manage_watchlist.action": ["add", "remove"],
  "manage_playlist.mediaType": ["video", "audio"], "manage_collection.kind": ["movie", "show", "album"],
  "watch_history.kind": ["movie", "episode", "track"],
};
const INTEGERS: Record<string, number[]> = {
  year: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], maxDurationMin: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], offset: [0, Number.MAX_SAFE_INTEGER],
  "list_media.limit": [1, 200], "library_changes.limit": [1, 200], "get_children.limit": [1, 200], "person_credits.limit": [1, 200], "watch_history.limit": [1, 200],
  "search.limit": [1, 50], "similar_items.limit": [1, 50], "continue_watching.limit": [1, 100], "get_watchlist.limit": [1, 100], "random_pick.count": [1, 10], "play_item.offsetMs": [0, Number.MAX_SAFE_INTEGER],
  "tautulli_stats.days": [1, 3650], "tautulli_stats.count": [1, 50], "tautulli_history.days": [1, 3650], "tautulli_history.limit": [1, 500],
};
const BOOLEANS = new Set(["detail", "playlist", "includeUserStats", "watched"]);
// Ids are spliced into request paths, so each one is held to a run of digits.
const PLEX_ID = { type: "string", pattern: "^\\d+$" };
const IDS = new Set(["ratingKey", "playlistId", "collectionId"]);
const ARRAYS: Record<string, Record<string, number>> = { fields: {}, "set_watched.ratingKeys": { minItems: 1, maxItems: 100 }, "manage_playlist.ratingKeys": { maxItems: 500 }, "manage_collection.ratingKeys": { maxItems: 500 }, "manage_watchlist.ratingKeys": { minItems: 1, maxItems: 100 } };

function assertSchemaConstraints(tool: Tool) {
  for (const [name, property] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
    const key = `${tool.name}.${name}`;
    if (ENUMS[key]) {
      assert.equal(property.type, "string", key);
      assert.deepEqual(property.enum, ENUMS[key], key);
    } else if (INTEGERS[key] ?? INTEGERS[name]) {
      assert.equal(property.type, "integer", key);
      assert.equal(property.minimum, (INTEGERS[key] ?? INTEGERS[name])[0], key);
      assert.equal(property.maximum, (INTEGERS[key] ?? INTEGERS[name])[1], key);
    } else if (ARRAYS[key] ?? ARRAYS[name]) {
      assert.equal(property.type, "array", key);
      assert.deepEqual(property.items, name === "ratingKeys" ? PLEX_ID : { type: "string" }, key);
      for (const [constraint, value] of Object.entries(ARRAYS[key] ?? ARRAYS[name])) assert.equal(property[constraint], value, key);
    } else if (key === "rate_item.rating") {
      assert.deepEqual(property.anyOf, [{ type: "number", minimum: 0, maximum: 10 }, { type: "null" }], key);
    } else if (IDS.has(name)) {
      assert.equal(property.type, PLEX_ID.type, key);
      assert.equal(property.pattern, PLEX_ID.pattern, key);
    } else if (BOOLEANS.has(name)) {
      assert.equal(property.type, "boolean", key);
    } else {
      assert.equal(property.type, "string", key);
    }
  }
}

test("MCP protocol: tool and schema contract covers every capability configuration", async () => {
  const tautulli = { call: async () => [] };
  const configurations = [
    { options: {}, expectedNames: BASE_TOOLS },
    { options: { playback: true }, expectedNames: [...BASE_TOOLS, "list_clients", "play_item"] },
    { options: { tautulli }, expectedNames: [...BASE_TOOLS, "tautulli_stats", "tautulli_history"] },
    { options: { playback: true, tautulli }, expectedNames: [...BASE_TOOLS, "list_clients", "play_item", "tautulli_stats", "tautulli_history"] },
  ];
  for (const { options, expectedNames } of configurations) {
    const p = await protocol(options);
    try {
      const tools = (await p.client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name), expectedNames);
      for (const tool of tools) {
        const { properties, required, defaults } = SCHEMA_CONTRACT[tool.name];
        assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), properties, tool.name);
        assert.deepEqual(tool.inputSchema.required ?? [], required, tool.name);
        assert.deepEqual(Object.fromEntries(Object.entries(tool.inputSchema.properties ?? [])
          .filter(([, schema]) => Object.hasOwn(schema, "default"))
          .map(([name, schema]) => [name, (schema as { default?: unknown }).default])), defaults, tool.name);
        assertSchemaConstraints(tool);
      }
    } finally {
      await p.close();
    }
  }
});

// A tool whose detail=true caps its page has to state the cap effLimit
// applies. The test calls every tool that takes limit and detail to see which
// ones cap, and the list at the end keeps it from passing because it found none.
test("MCP tools: a tool whose detail=true caps limit says so in its description, with the cap it applies", async () => {
  const sizes: number[] = [];
  const client = {
    as: async function (this: PlexClient) { return this; },
    sectionByTitle: async (title: string) => ({ key: "1", type: "movie", title }),
    resolvePerson: async (name: string) => ({ id: "1", name }),
    resolveSectionTag: async (_key: string, _type: string, name: string) => ({ id: "1", name }),
    plex: async (_path: string, _params: unknown, opts: { size?: number } = {}) => {
      if (opts.size !== undefined) sizes.push(opts.size);
      return { size: 0, Metadata: [] };
    },
  } as unknown as PlexClient;
  const capped: string[] = [];
  for (const [name, tool] of Object.entries(buildTools(client, { playback: true, tautulli: { call: async () => [] } }))) {
    if (!("detail" in tool.inputSchema) || !("limit" in tool.inputSchema)) continue;
    sizes.length = 0;
    await assert.doesNotReject(async () => tool.invoke({ ratingKey: "1", name: "Someone", limit: 100, detail: true }), name);
    assert.ok(sizes.length > 0, `${name} sent no sized request`);
    assert.ok(sizes.every((size) => size === 100 || size === DETAIL_CAP), `${name} capped limit at something other than ${DETAIL_CAP}: ${sizes}`);
    if (sizes.every((size) => size === DETAIL_CAP)) capped.push(name);
    assert.equal(tool.description.includes(`detail=true caps limit at ${DETAIL_CAP}`), capped.includes(name), name);
  }
  assert.deepEqual(capped, ["list_media", "library_changes", "get_children", "person_credits", "continue_watching"]);
});

// random_pick's count stops at 10, under the cap, so the test above skips it.
// It still names detail's fields as examples, in the words the other tools use.
test("MCP tools: random_pick names detail's fields as examples and states no cap", () => {
  const { random_pick } = buildTools({} as PlexClient);
  assert.ok(random_pick.description.includes(`detail=true adds ${DETAIL_FIELDS_PHRASE}`), random_pick.description);
  assert.ok(!random_pick.description.includes("caps limit"), random_pick.description);
});

// Annotations are how a client tells a read from a write without parsing the
// description. Absent keys default to the worst case (destructive, open-world),
// so every tool states all four.
const MUTATING_TOOLS = ["set_watched", "rate_item", "manage_playlist", "manage_collection", "manage_watchlist", "scan_library", "play_item"];
const DESTRUCTIVE_TOOLS = ["manage_playlist", "manage_collection"];
// set_watched is left out: marking watched scrobbles, so a repeat records another play.
const IDEMPOTENT_WRITES = ["rate_item", "manage_watchlist"];

test("MCP protocol: every tool carries a title and all four annotations", async () => {
  const p = await protocol({ playback: true, tautulli: { call: async () => [] } });
  try {
    const tools = (await p.client.listTools()).tools;
    assert.equal(tools.length, Object.keys(SCHEMA_CONTRACT).length);
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string", tool.name);
      assert.ok(tool.title!.length > 0, tool.name);
      assert.deepEqual(Object.keys(tool.annotations ?? {}).sort(), ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"], tool.name);
      const mutates = MUTATING_TOOLS.includes(tool.name);
      assert.equal(tool.annotations!.readOnlyHint, !mutates, tool.name);
      assert.equal(tool.annotations!.destructiveHint, DESTRUCTIVE_TOOLS.includes(tool.name), tool.name);
      assert.equal(tool.annotations!.idempotentHint, !mutates || IDEMPOTENT_WRITES.includes(tool.name), tool.name);
      assert.equal(tool.annotations!.openWorldHint, false, tool.name);
    }
    assert.equal(new Set(tools.map((tool) => tool.title)).size, tools.length, "titles are unique");
  } finally {
    await p.close();
  }
});

const WRITE_TOOLS = ["set_watched", "rate_item", "manage_playlist", "manage_collection", "manage_watchlist", "scan_library"];

test("MCP protocol: readOnly lists no tool that writes, and the same build without it lists all six writes", async () => {
  for (const readOnly of [true, false]) {
    const p = await protocol({ readOnly, playback: true, tautulli: { call: async () => [] } });
    try {
      const tools = (await p.client.listTools()).tools;
      const writes = tools.filter((tool) => tool.annotations!.readOnlyHint === false).map((tool) => tool.name);
      assert.deepEqual(writes, readOnly ? [] : [...WRITE_TOOLS, "play_item"], `readOnly: ${readOnly}`);
      if (readOnly) assert.ok(tools.some((tool) => tool.name === "tautulli_stats"), "Tautulli tools are reads and stay");
    } finally {
      await p.close();
    }
  }
});

test("MCP protocol: readOnly leaves playback unregistered even with playback on", async () => {
  const p = await protocol({ readOnly: true, playback: true });
  try {
    const names = (await p.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes("play_item"), false);
    assert.equal(names.includes("list_clients"), false);
    assert.equal(names.includes("manage_watchlist"), false);
    assert.deepEqual(names, BASE_TOOLS.filter((name) => !WRITE_TOOLS.includes(name)));
  } finally {
    await p.close();
  }
});

const recordingFetch = () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => { calls.push(String(input)); throw new Error("no network in unit tests"); };
  return { calls, fetchImpl };
};

test("MCP protocol: a Tautulli older than 2.18.0 is a tool error naming the floor, without Tautulli's message", async () => {
  const body = JSON.stringify({ response: { result: "error", message: "Parameter apikey is required at /srv/tautulli", data: {} } });
  const tautulli = makeTautulli({ baseUrl: "http://tautulli.test:8181", apiKey: "k3y", fetchImpl: async () => ({ ok: false, status: 400, text: async () => body }) });
  const p = await protocol({ tautulli });
  try {
    const result = await p.client.callTool({ name: "tautulli_history", arguments: {} });
    assert.equal(result.isError, true);
    const text = (result.content as TextContent[])[0]!.text;
    assert.match(text, /Tautulli is 2\.18\.0 or later/);
    assert.doesNotMatch(text, /apikey is required|\/srv\/tautulli|k3y/);
  } finally {
    await p.close();
  }
});

test("MCP protocol: a tools/call over the input element limit is refused before any handler runs", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const p = await protocol({}, fetchImpl);
  try {
    // list_media's schema puts no cap on fields, so only the element limit
    // stands between this call and its handler: 1 member plus 1000 elements.
    const fields = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS }, (_, i) => `f${i}`);
    const result = await p.client.callTool({ name: "list_media", arguments: { fields } });
    assert.equal(result.isError, true);
    assert.match((result.content as TextContent[])[0]!.text, new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
    assert.equal(calls.length, 0);
  } finally {
    await p.close();
  }
});

test("MCP protocol: a tool that rejects with a non-Error answers with the value as text", async () => {
  // A fake client, because a rejected fetch reaches the handler as an Error.
  const p = await protocol({}, noNetwork, { ...testClient(), plex: () => Promise.reject("boom") });
  try {
    const result = await p.client.callTool({ name: "list_libraries", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal((result.content as TextContent[])[0]!.text, "Error: boom");
  } finally {
    await p.close();
  }
});

test("MCP protocol: the longest ratingKeys list a tool takes fits under the input element limit", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const p = await protocol({}, fetchImpl);
  try {
    const ratingKeys = Array.from({ length: 500 }, (_, i) => String(i + 1));
    const result = await p.client.callTool({ name: "manage_playlist", arguments: { action: "add_items", playlistId: "9", ratingKeys } });
    assert.doesNotMatch((result.content as TextContent[])[0]!.text, /more than the maximum/);
    assert.ok(calls.length > 0, "the handler ran and reached the network");
  } finally {
    await p.close();
  }
});

test("buildServer: registers all tool families on a fresh McpServer", () => {
  const c = testClient();
  const a = buildServer(c);
  const b = buildServer(c);
  assert.notEqual(a.server, b.server); // factory returns fresh instances
  assert.ok(a.toolNames.includes("list_libraries"));
  assert.ok(a.toolNames.includes("get_extras"));
  assert.ok(a.toolNames.includes("watch_history"));
  assert.ok(a.toolNames.includes("set_watched"));
  assert.ok(a.toolNames.includes("scan_library"));
  assert.ok(a.toolNames.includes("library_changes"));
  assert.ok(a.toolNames.includes("similar_items"));
  assert.ok(a.toolNames.includes("random_pick"));
  assert.ok(a.toolNames.includes("continue_watching"));
  assert.ok(a.toolNames.length >= 20);
});

test("buildServer: handshake advertises the package.json version", async () => {
  const { server } = buildServer(testClient());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getServerVersion()!.version, pkg.version);
    assert.equal(client.getServerVersion()!.name, "plex");
  } finally {
    await client.close();
    await server.close();
  }
});

// The registry entry, package.json and the Dockerfile each state part of one
// contract, and the registry rejects a publish where they disagree. Each check
// here is one the registry's validator enforces, or one that keeps the image's
// listing true to how the image runs.
type ServerPackage = {
  registryType: string;
  identifier: string;
  version?: string;
  transport: { type: string; url: string };
  environmentVariables: Array<{ name: string }>;
  runtimeArguments?: Array<{ name: string; value: string }>;
};
type Manifest = { $schema: string; name: string; version: string; packages: ServerPackage[]; [field: string]: unknown };
const readRepoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = (): Manifest => JSON.parse(readRepoFile("server.json"));
const ociPackage = (m: Manifest) => {
  const oci = m.packages.find((p) => p.registryType === "oci");
  assert.ok(oci, "server.json has no oci package");
  return oci;
};
const dockerfile = readRepoFile("Dockerfile");
const publishArgument = (oci: ServerPackage) => {
  const publish = (oci.runtimeArguments ?? []).find((a) => a.name === "--publish");
  assert.ok(publish, "the oci package has no --publish runtime argument");
  return publish.value;
};

test("server.json, mcpName and the image label name the same server", () => {
  const { name } = manifest();
  const label = dockerfile.match(/^LABEL io\.modelcontextprotocol\.server\.name="([^"]+)"/m)?.[1];
  assert.equal(pkg.mcpName, name);
  assert.equal(label, name);
});

// The string limits the declared schema revision sets on server.json's own
// fields, copied from that revision so the test fetches nothing. Bumping
// $schema fails here until the limits are re-read from the new revision.
const SCHEMA_STRING_LIMITS: Record<string, Record<string, { min?: number; max: number; optional?: boolean }>> = {
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json": {
    name: { min: 3, max: 200 },
    title: { min: 1, max: 100, optional: true },
    description: { min: 1, max: 100 },
    version: { max: 255 },
  },
};

test("server.json's fields fit the string limits of the schema it declares", () => {
  const m = manifest();
  const limits = SCHEMA_STRING_LIMITS[m.$schema];
  assert.ok(limits, `no recorded string limits for ${m.$schema}; copy them from that schema revision`);
  for (const [field, { min = 0, max, optional = false }] of Object.entries(limits)) {
    if (optional && !(field in m)) continue;
    assert.equal(typeof m[field], "string", `${field} is missing or not a string`);
    // JSON Schema counts code points, not UTF-16 units.
    const length = [...(m[field] as string)].length;
    assert.ok(length >= min && length <= max, `${field} is ${length} characters; the schema allows ${min}–${max}`);
  }
});

test("server.json lists the npm package and the image at package.json's version", () => {
  const m = manifest();
  assert.equal(m.version, pkg.version);
  assert.deepEqual(m.packages.map((p) => p.registryType), ["npm", "oci"]);
  const npm = m.packages.find((p) => p.registryType === "npm");
  assert.equal(npm!.identifier, pkg.name);
  assert.equal(npm!.version, pkg.version);
  const oci = ociPackage(m);
  assert.equal(oci.identifier, `ghcr.io/dustinhansen/plex-mcp:v${pkg.version}`);
  assert.equal("version" in oci, false, "the registry rejects a version field on an oci package");
  assert.equal("registryBaseUrl" in oci, false, "the registry rejects registryBaseUrl on an oci package");
});

test("the image's URL template carries the path secret and only its own variables", () => {
  const oci = ociPackage(manifest());
  assert.equal(oci.transport.type, "streamable-http");
  assert.match(oci.transport.url, /\{MCP_PATH_SECRET\}/);
  const names = new Set(oci.environmentVariables.map((v) => v.name));
  for (const [, variable] of oci.transport.url.matchAll(/\{([^}]+)\}/g)) assert.ok(names.has(variable), `{${variable}} is not one of the package's environment variables`);
});

test("the image's URL, its port mapping and the Dockerfile's PORT agree", () => {
  const oci = ociPackage(manifest());
  const urlPort = new URL(oci.transport.url.replace(/\{[^}]+\}/g, "x")).port;
  const dockerPorts = [...dockerfile.matchAll(/^ENV\b.*?\bPORT[= ](\d+)/gm)].map(([, port]) => port);
  assert.equal(dockerPorts.length, 1, "expected exactly one ENV line setting PORT in the Dockerfile");
  const [, hostPort, containerPort] = publishArgument(oci).match(/^127\.0\.0\.1:(\d+):(\d+)$/) ?? [];
  assert.equal(urlPort, dockerPorts[0]);
  assert.equal(hostPort, dockerPorts[0], "the port must be published on 127.0.0.1 at the same port");
  assert.equal(containerPort, dockerPorts[0]);
});

// The image listens on every interface, so the published port alone decides
// who can reach it. The pages people copy from publish it the way the registry
// entry does. The scan reads every entry of a compose `ports:` list and every
// -p or --publish of a `docker run`, including its continuation lines.
test("the README and docs/docker.md publish the port as the registry entry does", () => {
  const publish = publishArgument(ociPackage(manifest()));
  for (const path of ["README.md", "docs/docker.md"]) {
    const doc = readRepoFile(path);
    const compose = [...doc.matchAll(/^[ \t]*ports:\n((?:[ \t]*- .*\n)+)/gm)]
      .flatMap(([, list]) => [...list.matchAll(/^[ \t]*- "?([^"\s]+)"?/gm)].map(([, mapping]) => mapping));
    const run = [...doc.matchAll(/^docker run\b(?:.*\\\n)*.*/gm)]
      .flatMap(([command]) => [...command.matchAll(/(?<!\S)(?:-p|--publish)[ =](\S+)/g)].map(([, mapping]) => mapping));
    assert.ok(compose.length > 0, `${path} has no compose ports: entry`);
    assert.ok(run.length > 0, `${path} has no docker run port mapping`);
    for (const mapping of [...compose, ...run]) assert.equal(mapping, publish, `${path} publishes ${mapping}`);
  }
});

// The scan finds `process.env.NAME` and `process.env["NAME"]`. A read written
// any other way fails this test loudly rather than passing it, so a refactor
// that changes how the server reads its environment updates the scan too.
test("both packages list only environment variables the server reads, never the auth opt-out", () => {
  const source = ["index.ts", ...readdirSync(new URL("../lib/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`)].map(readRepoFile).join("\n");
  const read = new Set([...source.matchAll(/process\.env(?:\.|\[["'])([A-Z0-9_]+)/g)].map(([, name]) => name));
  for (const p of manifest().packages) {
    for (const v of p.environmentVariables) assert.ok(read.has(v.name), `${p.registryType} lists ${v.name}, which the server never reads`);
    assert.equal(p.environmentVariables.some((v) => v.name === "MCP_ALLOW_NO_AUTH"), false, `${p.registryType} lists the auth opt-out`);
  }
});

test("the package is a bin with no import entry point, so importing it cannot start a server", () => {
  assert.equal(pkg.bin["plex-mcp"], "dist/index.js");
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined);
});

test("CLI version stays in sync with package.json", () => {
  const output = execFileSync(process.execPath, [indexPath, "--version"], { encoding: "utf8" });
  assert.equal(output.trim(), pkg.version);
});

test("HTTP CLI refuses to start without its path secret", () => {
  const child = spawnSync(process.execPath, [indexPath], {
    encoding: "utf8",
    env: { ...process.env, PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "tok", MCP_TRANSPORT: "http", MCP_PATH_SECRET: "", MCP_ALLOW_NO_AUTH: "" },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /MCP_PATH_SECRET is required in http mode/);
});

/** Run the CLI in http mode with `secret` as MCP_PATH_SECRET, expecting it to
 *  refuse before it listens. */
function refusedSecret(secret: string) {
  const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ MCP_PATH_SECRET: secret }) });
  assert.equal(child.status, 1);
  const lines = child.stderr.trim().split("\n");
  assert.equal(lines.length, 1, child.stderr);
  // The whole line is fixed, which shows the value is absent even for the
  // secret "1", a substring of the "16" the line has to name.
  assert.equal(lines[0], "MCP_PATH_SECRET must be at least 16 characters of letters, digits, -, _, . or ~ (openssl rand -hex 32 makes one)");
  return lines[0];
}

test("HTTP CLI refuses a path secret shorter than 16 characters, without printing it", () => {
  const line = refusedSecret("1");
  assert.match(line, /MCP_PATH_SECRET/);
  assert.match(line, /at least 16 characters/);
});

test("HTTP CLI refuses a path secret holding a character outside the path-safe set", () => {
  const line = refusedSecret("abcdefghij/klmnopqrs");
  assert.match(line, /MCP_PATH_SECRET/);
  assert.match(line, /letters, digits, -, _, \. or ~/);
});

/** Start the CLI with `env` and resolve once its stderr matches `pattern`,
 *  leaving it running for the caller to stop. Stdin stays a pipe so the stdio
 *  transport keeps running. */
async function runningCli(env: NodeJS.ProcessEnv, pattern: RegExp) {
  const child = spawn(process.execPath, [indexPath], { env, stdio: ["pipe", "ignore", "pipe"] });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  try {
    const match = await new Promise<RegExpMatchArray>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`no startup line within 10s:\n${stderr}`)), 10_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const found = stderr.match(pattern);
        if (found) { clearTimeout(timer); resolve(found); }
      });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before starting:\n${stderr}`)); });
    });
    return { child, match, exited };
  } catch (e) {
    child.kill("SIGKILL");
    await exited;
    throw e;
  }
}

/** Start the CLI with `env`, resolve with the first match of `pattern` in its
 *  stderr, and stop it. */
async function cliStartup(env: NodeJS.ProcessEnv, pattern: RegExp) {
  const cli = await runningCli(env, pattern);
  cli.child.kill();
  await cli.exited;
  return cli.match;
}

/** The shape `openssl rand -hex 32` makes, which the docs recommend. */
const pathSecret = "0123456789abcdef".repeat(4);

const cliEnv = (overrides: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "tok", MCP_TRANSPORT: "http", MCP_PATH_SECRET: pathSecret, MCP_ALLOW_NO_AUTH: "" };
  for (const name of ["PORT", "MCP_HOST", "HOST", "PLEX_READ_ONLY", "PLEX_ALLOW_PLAYBACK", "TAUTULLI_URL", "TAUTULLI_API_KEY"]) delete env[name];
  return Object.assign(env, overrides);
};

/** The http-mode listening line with a path secret set. It names where the
 *  secret goes in the URL, never the secret itself. */
const listeningLine = /listening on http:\/\/(.+):(\d+)\/<MCP_PATH_SECRET>\/mcp: /;

/** Start the CLI in http mode and read the address its listening line reports.
 *  `PORT`, `MCP_HOST` and `HOST` are unset unless `overrides` names them. */
async function httpListenAddress(overrides: Record<string, string>) {
  const [, host, port] = await cliStartup(cliEnv(overrides), listeningLine);
  return { host, port: Number(port) };
}

test("HTTP CLI starts with a 64-character hex path secret", async () => {
  await cliStartup(cliEnv({ PORT: "0" }), listeningLine);
});

/** The whole listening line, matched only once its newline has arrived so a
 *  line split across stderr chunks is never read half-written. */
const wholeListeningLine = /(listening on [^\n]*)\n/;

test("HTTP CLI's listening line names the secret's place in the path and never its value, and that path serves MCP", async () => {
  const cli = await runningCli(cliEnv({ PORT: "0" }), wholeListeningLine);
  try {
    const [, line] = cli.match;
    const [, host, port] = line.match(listeningLine) ?? assert.fail(`unexpected listening line: ${line}`);
    assert.doesNotMatch(line, /UNAUTHENTICATED/);
    assert.equal(line.includes(pathSecret), false);
    const initialize = (path: string) => fetch(`http://${host}:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    const served = await initialize(`/${pathSecret}/mcp`);
    assert.equal(served.status, 200);
    await served.body?.cancel();
    const bare = await initialize("/mcp");
    assert.equal(bare.status, 404);
    await bare.body?.cancel();
  } finally {
    cli.child.kill();
    await cli.exited;
  }
});

test("HTTP CLI's listening line names /mcp and says UNAUTHENTICATED with MCP_ALLOW_NO_AUTH=1", async () => {
  const [, line] = await cliStartup(cliEnv({ PORT: "0", MCP_PATH_SECRET: "", MCP_ALLOW_NO_AUTH: "1" }), wholeListeningLine);
  assert.match(line, /^listening on http:\/\/.+:\d+\/mcp: \d+ tools\. UNAUTHENTICATED \(MCP_ALLOW_NO_AUTH=1\)$/);
});

test("HTTP CLI listens on PORT when it is set", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  assert.equal((await httpListenAddress({ PORT: String(port) })).port, port);
});

test("HTTP CLI listens on 127.0.0.1 when MCP_HOST is unset, and on every interface with MCP_HOST=0.0.0.0", async () => {
  assert.equal((await httpListenAddress({ PORT: "0" })).host, "127.0.0.1");
  assert.equal((await httpListenAddress({ PORT: "0", MCP_HOST: "0.0.0.0" })).host, "0.0.0.0");
});

test("HTTP CLI ignores an inherited HOST and stays on 127.0.0.1", async () => {
  assert.equal((await httpListenAddress({ PORT: "0", HOST: "0.0.0.0" })).host, "127.0.0.1");
});

test("CLI startup lines report the read-only tool count with PLEX_READ_ONLY=1, in both transports", async () => {
  const count = BASE_TOOLS.length - WRITE_TOOLS.length;
  const readOnly = { PLEX_READ_ONLY: "1", PLEX_ALLOW_PLAYBACK: "1" };
  await cliStartup(cliEnv({ ...readOnly, MCP_TRANSPORT: "stdio" }), new RegExp(`running \\(stdio\\): ${count} tools \\(read-only\\)`));
  await cliStartup(cliEnv({ ...readOnly, PORT: "0" }), new RegExp(`/mcp: ${count} tools \\(read-only\\)`));
  for (const value of [undefined, "", "0"]) {
    await cliStartup(cliEnv({ MCP_TRANSPORT: "stdio", ...(value === undefined ? {} : { PLEX_READ_ONLY: value }) }), new RegExp(`running \\(stdio\\): ${BASE_TOOLS.length} tools\n`));
  }
});

/** Resolve with the exit code and signal, or fail if the process is still
 *  running after `ms`. */
async function exitWithin(cli: Awaited<ReturnType<typeof runningCli>>, ms: number) {
  const timer = setTimeout(() => cli.child.kill("SIGKILL"), ms);
  const started = Date.now();
  const [code, signal] = await cli.exited;
  clearTimeout(timer);
  assert.ok(Date.now() - started < ms, `still running ${ms}ms after the signal`);
  return { code, signal };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`HTTP CLI exits 0 within 2 seconds of ${signal}`, async () => {
    const cli = await runningCli(cliEnv({ PORT: "0" }), listeningLine);
    cli.child.kill(signal);
    assert.deepEqual(await exitWithin(cli, 2_000), { code: 0, signal: null });
  });
}

test("HTTP CLI answers a request it accepted before SIGTERM, then exits 0", { timeout: 15_000 }, async (t) => {
  let plexHit!: () => void;
  const plexReached = new Promise<void>((resolve) => { plexHit = resolve; });
  let releasePlex!: () => void;
  const plexReleased = new Promise<void>((resolve) => { releasePlex = resolve; });
  const plex = createHttpServer(async (_req, res) => {
    plexHit();
    await plexReleased;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: { Directory: [{ title: "Movies", type: "movie", key: "1" }] } }));
  });
  await new Promise<void>((resolve) => plex.listen(0, "127.0.0.1", resolve));
  let cli: Awaited<ReturnType<typeof runningCli>> | undefined;
  try {
    const plexPort = (plex.address() as AddressInfo).port;
    cli = await runningCli(cliEnv({ PORT: "0", PLEX_URL: `http://127.0.0.1:${plexPort}` }), listeningLine);
    const [, host, port] = cli.match;
    // A timeout does not stop a test body, so every wait below has to end on
    // its own for the cleanup in `finally` to run. Both fetches take the
    // test's signal, which aborts on a timeout.
    const response = fetch(`http://${host}:${port}/${pathSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_libraries", arguments: {} } }),
      signal: t.signal,
    });
    await Promise.race([
      plexReached,
      response.then((res) => { throw new Error(`answered ${res.status} before reaching Plex`); }),
    ]);
    cli.child.kill("SIGTERM");
    // Plex answers only once a new connection is refused, so the response
    // has to come from a server that has already closed its listener.
    const deadline = Date.now() + 2_000;
    while (await fetch(`http://${host}:${port}/health`, { signal: t.signal }).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, "listener still accepting 2s after SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    releasePlex();
    const res = await response;
    assert.equal(res.status, 200);
    const body = await res.json() as { result?: { content: TextContent[] } };
    assert.match(body.result?.content[0].text ?? "", /Movies/);
    assert.deepEqual(await exitWithin(cli, 2_000), { code: 0, signal: null });
  } finally {
    cli?.child.kill("SIGKILL");
    releasePlex();
    plex.closeAllConnections();
    await new Promise((resolve) => plex.close(resolve));
  }
});

test("stdio CLI registers no signal handler, so SIGTERM ends it by signal", async () => {
  const cli = await runningCli(cliEnv({ MCP_TRANSPORT: "stdio" }), /running \(stdio\)/);
  cli.child.kill("SIGTERM");
  assert.deepEqual(await exitWithin(cli, 2_000), { code: null, signal: "SIGTERM" });
});

test("CLI refuses a PLEX_READ_ONLY value other than 1, 0 or empty", () => {
  const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ MCP_TRANSPORT: "stdio", PLEX_READ_ONLY: "true" }) });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /PLEX_READ_ONLY must be 1, 0 or empty, not "true"/);
});

test("CLI refuses an MCP_TRANSPORT value other than stdio or http", () => {
  const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ MCP_TRANSPORT: "HTTP" }) });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /MCP_TRANSPORT must be stdio or http, not "HTTP"/);
});

for (const [name, value, extra] of [
  ["PLEX_URL", "not a url", {}],
  ["PLEX_URL", "plex-host:32400", {}],
  ["TAUTULLI_URL", "ftp://tautulli", { TAUTULLI_API_KEY: "key" }],
  ["TAUTULLI_URL", "ftp://tautulli", {}],
] as const) {
  test(`CLI refuses ${name}=${value}${"TAUTULLI_API_KEY" in extra ? " (TAUTULLI_API_KEY set)" : ""} with 1 line`, () => {
    const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ MCP_TRANSPORT: "stdio", ...extra, [name]: value }) });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, `${name} must be an http or https URL, not "${value}"\n`);
  });
}

for (const url of ["https://plex.test:32400", "http://plex.test:32400/plex", "http://plex.test:32400/"]) {
  test(`stdio CLI starts with PLEX_URL=${url}`, async () => {
    await cliStartup(cliEnv({ MCP_TRANSPORT: "stdio", PLEX_URL: url }), /running \(stdio\)/);
  });
}

for (const [name, value] of [["TAUTULLI_URL", "http://tautulli.test:8181"], ["TAUTULLI_API_KEY", "key"]]) {
  test(`CLI refuses ${name} set without the other with 1 line`, () => {
    const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ MCP_TRANSPORT: "stdio", [name]: value }) });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, "TAUTULLI_URL and TAUTULLI_API_KEY must be set together or not at all\n");
  });
}

test("CLI registers the 2 Tautulli tools with both TAUTULLI_URL and TAUTULLI_API_KEY set, and none with neither", async () => {
  const both = { TAUTULLI_URL: "http://tautulli.test:8181", TAUTULLI_API_KEY: "key" };
  await cliStartup(cliEnv({ ...both, MCP_TRANSPORT: "stdio" }), new RegExp(`running \\(stdio\\): ${BASE_TOOLS.length + 2} tools\n`));
  await cliStartup(cliEnv({ MCP_TRANSPORT: "stdio" }), new RegExp(`running \\(stdio\\): ${BASE_TOOLS.length} tools\n`));
});

for (const port of ["abc", "70000"]) {
  test(`CLI refuses PORT=${port} with 1 line`, () => {
    const child = spawnSync(process.execPath, [indexPath], { encoding: "utf8", env: cliEnv({ PORT: port }) });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, `PORT must be an integer from 0 to 65535, not "${port}"\n`);
  });
}

test("CLI refuses a port already in use with 1 line naming the address", async () => {
  const holder = createServer().listen(0, "127.0.0.1");
  await once(holder, "listening");
  const { port } = holder.address() as AddressInfo;
  const child = spawn(process.execPath, [indexPath], { env: cliEnv({ PORT: String(port) }), stdio: ["pipe", "ignore", "pipe"] });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  // If the CLI ever binds the held port, it would run until killed.
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(stderr, `cannot listen on 127.0.0.1:${port}: EADDRINUSE\n`);
    assert.doesNotMatch(stderr, /^\s+at /m);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("MCP protocol: prompts and plex://libraries retain their client-visible output", async () => {
  const p = await protocol({}, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: { Directory: [{ title: "Movies", type: "movie", key: "1" }] } }) }));
  try {
    const prompts = await p.client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), ["movie_night", "whats_new"]);
    const msg = await p.client.getPrompt({ name: "movie_night", arguments: { library: "Movies", mood: "cozy" } });
    assert.match((msg.messages[0].content as TextContent).text, /random_pick/);
    assert.match((msg.messages[0].content as TextContent).text, /cozy/);
    const resources = await p.client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri), ["plex://libraries"]);
    const out = await p.client.readResource({ uri: "plex://libraries" });
    assert.match((out.contents[0] as TextResourceContents).text, /"libraryType": "Movies"/);
  } finally {
    await p.close();
  }
});
