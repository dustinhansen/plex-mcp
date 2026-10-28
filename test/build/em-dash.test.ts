// The runtime's strings are written in the same voice as the docs (AGENTS.md).
// Tool descriptions reach every client's model and error messages reach its
// user, so this sweeps the tracked runtime sources for the em dash, which the
// doc-voice sweep catches only in Markdown. Comments are swept too, because a
// file is easier to keep clean whole than line by line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchingLines, RUNTIME_SOURCES, sweepTree, trackedFiles, type LineHit } from "./sweep.ts";

// Escaped, so this file holds no em dash of its own. Files outside
// RUNTIME_SOURCES still do, so a grep of the whole tree is not empty.
const EM_DASH = "\u2014";

const hasEmDash = (line: string) => line.includes(EM_DASH);
const hitText = (hits: LineHit[]) => hits.map(({ path, line, text }) => `${path}:${line} ${text.trim()}`);
const emDashHits = (path: string, source: string) => hitText(matchingLines(path, source, hasEmDash));

test("no tracked runtime source has an em dash", () => {
  const files = trackedFiles(RUNTIME_SOURCES);
  assert.ok(
    files.includes("index.ts") && files.includes("lib/tools-read.ts") && files.includes("smoke.ts"),
    "the sweep reads the tree",
  );
  assert.deepEqual(hitText(sweepTree(files, hasEmDash)), []);
});

test("an em dash is caught, and the hyphen and en dash are not", () => {
  assert.equal(emDashHits("x.ts", `throw new Error("Bad decade ${EM_DASH} use e.g. 1970s");`).length, 1);
  for (const line of [
    'throw new Error("Bad decade. Use e.g. 1970s");',
    "// Pages run 1-50, then 51-100.",
    "// Seasons 1\u20133.",
  ]) {
    assert.deepEqual(emDashHits("x.ts", line), [], line);
  }
});
