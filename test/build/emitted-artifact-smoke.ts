#!/usr/bin/env node
/**
 * Offline smoke harnesses for the package and image emitted by the build.
 * They deliberately live outside the package: running either command
 * never publishes, deploys, dispatches, or changes the production entrypoint.
 *
 * Checkout example (packs this checkout's built dist/ and installs it on the
 * running Node; `npm run test:artifact` builds first and runs this):
 *   node test/build/emitted-artifact-smoke.ts checkout
 *
 * Package example (each --nodeNN is optional; at least one is required):
 *   npm pack --pack-destination /tmp/out
 *   node test/build/emitted-artifact-smoke.ts package \
 *     --tarball /tmp/out/dustinhansen-plex-mcp-<version>.tgz \
 *     --node22 /path/to/node-22 --node24 /path/to/node-24
 *
 * Image example (one explicit, bounded architecture per run):
 *   node test/build/emitted-artifact-smoke.ts container \
 *     --image plex-mcp:candidate --platform linux/arm64
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string }).name;
const MCP_INIT = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "emitted-artifact-smoke", version: "0.0.0" },
};
const PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);

function command(command: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function nodeMajor(node: string) {
  const version = command(node, ["--version"]);
  const match = /^v(\d+)\./.exec(version);
  if (!match) throw new Error(`${node} did not report a Node.js version: ${version}`);
  return Number(match[1]);
}

function requirePlatform(platform: string) {
  if (!PLATFORMS.has(platform)) {
    throw new Error(`--platform must be linux/amd64 or linux/arm64, received ${platform || "nothing"}`);
  }
}

async function connectStdio(node: string, entry: string) {
  const transport = new StdioClientTransport({
    command: node,
    args: [entry],
    env: { ...process.env, PLEX_URL: "http://plex.fixture:32400", PLEX_TOKEN: "fixture-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "emitted-artifact-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "list_libraries"), "stdio initializes the read tool surface");
  } finally {
    await client.close();
  }
}

interface NodeTarget {
  major: number;
  path: string;
}

/** Install a tarball into a new directory for each target Node and exercise
 * the installed CLI.
 *
 * The tarball's own dependency ranges (e.g. the SDK's `zod` range) are wider
 * than this project's, so a lockfile-less resolution of the packed tree can
 * legitimately pick versions our own `npm ci` never fetched — an `--offline`
 * install of a tarball would then hit ENOTCACHED even on a fully warm cache.
 * Warm the cache with one online install first, then repeat the install
 * `--offline` into a clean directory: the second install must resolve to the
 * same versions and satisfy itself entirely from that warm cache, which is
 * what actually proves the packed artifact installs reproducibly. */
export async function verifyPackedArtifact({ tarball, nodes, npm = "npm" }: { tarball: string; nodes: NodeTarget[]; npm?: string }) {
  if (!tarball) throw new Error("--tarball is required");
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("at least one Node target is required");
  const absoluteTarball = resolve(tarball);
  const installArgs = ["--omit=dev", "--ignore-scripts", "--no-package-lock", "--no-save"];
  for (const { major, path } of nodes) {
    if (nodeMajor(path) !== major) throw new Error(`${path} is not Node ${major}`);
    const warmDir = mkdtempSync(join(tmpdir(), `plex-mcp-artifact-node${major}-warm-`));
    const installDir = mkdtempSync(join(tmpdir(), `plex-mcp-artifact-node${major}-`));
    try {
      command(npm, ["install", ...installArgs, "--prefix", warmDir, absoluteTarball]);
      command(npm, ["install", "--offline", ...installArgs, "--prefix", installDir, absoluteTarball]);
      const entry = join(installDir, "node_modules", ...packageName.split("/"), "dist", "index.js");
      const version = command(path, [entry, "--version"]);
      assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "installed CLI prints a semver version");
      await connectStdio(path, entry);
    } finally {
      rmSync(warmDir, { recursive: true, force: true });
      rmSync(installDir, { recursive: true, force: true });
    }
  }
}

/** Pack this checkout and verify the tarball on the running Node. */
export async function verifyCheckoutPack() {
  const output = mkdtempSync(join(tmpdir(), "plex-mcp-pack-"));
  try {
    // --ignore-scripts packs the dist/ the caller already built. Without it
    // npm runs prepack, which is `rm -rf dist && tsc`, and rebuilds it.
    const packed = command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: repoRoot });
    const [{ filename }] = JSON.parse(packed) as Array<{ filename: string }>;
    const major = Number(process.versions.node.split(".")[0]);
    await verifyPackedArtifact({ tarball: join(output, filename), nodes: [{ major, path: process.execPath }] });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

function fixtureResponse(pathname: string) {
  if (pathname === "/library/sections") {
    return { MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movies", refreshing: false }] } };
  }
  if (pathname === "/library/sections/1/all") {
    return { MediaContainer: { size: 1, totalSize: 1, Metadata: [{ ratingKey: "42", title: "Fixture movie", type: "movie", year: 2024, viewCount: 0, addedAt: 1_700_000_000 }] } };
  }
  return { MediaContainer: {} };
}

/** A minimal Plex-shaped fixture for read-only representative calls. */
export async function startPlexFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fixtureResponse(new URL(req.url!, "http://fixture").pathname)));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    // The candidate runs in Docker, where host.docker.internal resolves to
    // the bridge gateway rather than the host loopback interface. The fixture
    // is ephemeral and only reachable from this local smoke run.
    server.listen(0, "0.0.0.0", resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://host.docker.internal:${port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function rpc<Result>(baseUrl: string, id: number, method: string, params: object): Promise<Result> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `${method} receives HTTP 200`);
  const body = await response.json();
  assert.equal(body.error, undefined, `${method} returns no JSON-RPC error: ${JSON.stringify(body)}`);
  return body.result as Result;
}

async function waitForHealth(baseUrl: string) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200 && await response.text() === "ok") return;
    } catch (error) { lastError = error as Error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`candidate container did not become healthy${lastError ? `: ${lastError.message}` : ""}`);
}

/** Wait for Docker's own verdict on the image's HEALTHCHECK. `/health`
 *  answering is not enough: an orchestrator only sees this status, and a probe
 *  that calls a binary the image lacks leaves a working server `unhealthy`
 *  forever. The candidate runs with a short --health-interval so
 *  this settles in seconds, but the command under test is the image's own. */
async function waitForDockerHealthy(docker: string, container: string) {
  const attempts = 120;
  const delayMs = 500;
  const format = "{{if .State.Health}}{{.State.Health.Status}}{{end}}";
  const healthLog = () => command(docker, ["inspect", "--format", "{{json .State.Health.Log}}", container]);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = command(docker, ["inspect", "--format", format, container]);
    if (status === "healthy") return;
    if (status === "") throw new Error("candidate image declares no HEALTHCHECK");
    if (status === "unhealthy") throw new Error(`candidate image's HEALTHCHECK reports unhealthy: ${healthLog()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
  }
  throw new Error(`candidate image's HEALTHCHECK did not report healthy within ${attempts * delayMs / 1000}s: ${healthLog()}`);
}

/** On a health-wait failure, print the candidate's state (still running, or
 *  exited with which code) and its stdout/stderr before the `finally` block
 *  below removes it — otherwise a flake here is undiagnosable. Requires the
 *  candidate to run without `--rm` (below): with it, Docker auto-removes an
 *  exited container before this can inspect it, which is exactly the crash
 *  case this exists to diagnose. */
function logContainerDiagnostics(docker: string, container: string) {
  const state = spawnSync(docker, ["inspect", "--format", "{{json .State}}", container], { encoding: "utf8" });
  console.error(`candidate container state: ${state.stdout?.trim() || state.stderr?.trim() || "(docker inspect failed)"}`);
  const logs = spawnSync(docker, ["logs", container], { encoding: "utf8" });
  console.error(`candidate container stdout:\n${logs.stdout || "(empty)"}`);
  console.error(`candidate container stderr:\n${logs.stderr || "(empty)"}`);
}

type ToolCallResult = { content: Array<{ text: string }> };

/** Run a candidate image exactly once for one requested architecture. */
export async function verifyCandidateContainer({ image, platform, docker = "docker" }: { image: string; platform: string; docker?: string }) {
  if (!image) throw new Error("--image is required");
  requirePlatform(platform);
  const fixture = await startPlexFixture();
  let container: string | undefined;
  try {
    container = command(docker, ["run", "--detach", "--platform", platform, "--add-host", "host.docker.internal:host-gateway", "--publish", "127.0.0.1::8627", "--health-interval", "1s", "--env", "MCP_TRANSPORT=http", "--env", "MCP_ALLOW_NO_AUTH=1", "--env", `PLEX_URL=${fixture.baseUrl}`, "--env", "PLEX_TOKEN=fixture-token", image]);
    const binding = command(docker, ["port", container, "8627/tcp"]);
    const port = binding.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error(`could not determine candidate container port from: ${binding}`);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl);
      await waitForDockerHealthy(docker, container);
    } catch (error) {
      logContainerDiagnostics(docker, container);
      throw error;
    }
    const initialized = await rpc<{ serverInfo: { name: string } }>(baseUrl, 1, "initialize", MCP_INIT);
    assert.equal(initialized.serverInfo.name, "plex");
    const listed = await rpc<{ tools: Array<{ name: string }> }>(baseUrl, 2, "tools/list", {});
    assert.ok(listed.tools.some((tool) => tool.name === "list_libraries"));
    const libraries = await rpc<ToolCallResult>(baseUrl, 3, "tools/call", { name: "list_libraries", arguments: {} });
    assert.match(libraries.content[0].text, /Fixture movie|Movies/);
    const media = await rpc<ToolCallResult>(baseUrl, 4, "tools/call", { name: "list_media", arguments: { library: "Movies", limit: 1 } });
    assert.match(media.content[0].text, /Fixture movie/);
  } finally {
    if (container) spawnSync(docker, ["rm", "--force", container], { encoding: "utf8" });
    await fixture.close();
  }
}

function usage() {
  return "Usage: emitted-artifact-smoke.ts checkout | package --tarball FILE [--node22 PATH] [--node24 PATH] (at least one) | container --image IMAGE --platform linux/amd64|linux/arm64";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.filter((_, index) => index % 2 === 0).map((name, index) => [name.replace(/^--/, ""), rest[index * 2 + 1]]));
  if (mode === "checkout") {
    await verifyCheckoutPack();
  } else if (mode === "package") {
    const nodes = ([[22, args.node22], [24, args.node24]] as Array<[number, string | undefined]>).filter(([, path]) => path).map(([major, path]) => ({ major, path: path! }));
    await verifyPackedArtifact({ tarball: args.tarball, nodes });
  } else if (mode === "container") {
    await verifyCandidateContainer({ image: args.image, platform: args.platform });
  } else {
    throw new Error(usage());
  }
}
