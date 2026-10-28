// Every tracked source, test and script is TypeScript. `npm test` runs only
// test/**/*.test.ts and test/tsconfig.json type-checks only .ts, so a tracked
// .js, .mjs or .cjs file would go unrun and unchecked without failing anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");

const javaScriptPaths = (paths: string[]) => paths.filter((path) => /\.(?:js|mjs|cjs)$/.test(path));

test("no tracked file is JavaScript", () => {
  const files = tracked();
  assert.ok(files.includes("index.ts") && files.includes("test/server.test.ts"), "the check reads the tree");
  assert.deepEqual(javaScriptPaths(files), []);
});

test("each JavaScript extension is caught, and the look-alikes are not", () => {
  assert.deepEqual(javaScriptPaths(["a.js", "test/b.test.js", "c.mjs", "d.cjs"]), ["a.js", "test/b.test.js", "c.mjs", "d.cjs"]);
  assert.deepEqual(javaScriptPaths(["a.ts", "b.json", "c.jsx.ts", "d.js.map.ts", "tsconfig.json"]), []);
});
