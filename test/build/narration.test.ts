// Comments and test names explain the code as it is, never how it came to be
// (AGENTS.md). This sweeps every tracked source, test and workflow file for
// the terms that mark history narration. It reads the literal text, so
// narration phrased some other way is for review to catch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { matchingLines, repoRoot, sweepTree, trackedFiles, type LineHit } from "./sweep.ts";

const self = relative(repoRoot, fileURLToPath(import.meta.url));
const SWEPT = ["*.ts", "*.js", "*.mjs", ".github/workflows/*.yml", "Dockerfile"];

// Built from pieces, like the samples below.
const HOME_LAB = "home" + "lab";
const FIRST_NAME = "Dus" + "tin";

const TERMS: Array<[term: string, pattern: RegExp]> = [
  // Any tracker's id: 2 to 6 capitals, a hyphen and digits. Standards and
  // content-rating names share the shape, so those prefixes pass. It is
  // case-sensitive, so a runner label like ubuntu-24.04 passes.
  ["a ticket identifier", /\b(?!(?:ISO|UTF|SHA|RFC|PG)-)[A-Z]{2,6}-\d/],
  [HOME_LAB, new RegExp(HOME_LAB, "i")],
  ["migration", /\bmigrat/i],
  ["cut-over", /\bcut-?over\b/i],
  // A version name for the code itself; "API v2" and an action ref's @v1
  // name someone else's version.
  ["v1/v2 as a version name", /(?<![\w./@-])(?<!API )(?<!API \()v[12](?![\w.])/i],
  ["0.9.0 only", /0\.9\.0 only|only for 0\.9\.0/i],
  // The word itself, so "the client launches the server" passes.
  ["launch", /\b(?:pre-?|post-?)?launch\b/i],
  ["a verified note", /\bverified\s+live\b|\bverified(?::|\s+\d{4}-)/i],
  // The word in any case. The dustinhansen account in package and image names
  // has no word break after the first name, so it does not match.
  ["the maintainer's first name", new RegExp(`\\b${FIRST_NAME}\\b`, "i")],
  ["back-compat", /\bback(?:wards?)?[- ]?compat/i],
  // Shouting at the next editor. Case-sensitive, so a plain "do not" or a
  // "critical section" passes.
  ["DO NOT in capitals", /\bDO NOT\b/],
  ["CRITICAL in capitals", /\bCRITICAL\b/],
  // The word on its own, so a futures API or a futureDate passes.
  ["future", /\bfuture\b/i],
];

const termsIn = (line: string) => TERMS.filter(([, pattern]) => pattern.test(line));
const hasTerm = (line: string) => termsIn(line).length > 0;

// One hit per term a line holds.
const hitText = (hits: LineHit[]) =>
  hits.flatMap(({ path, line, text }) => termsIn(text).map(([term]) => `${path}:${line} ${term}: ${text.trim()}`));

const narrationHits = (path: string, source: string) => hitText(matchingLines(path, source, hasTerm));

test("no tracked source, test or workflow file narrates history", () => {
  const files = trackedFiles(SWEPT, [self]);
  assert.ok(files.includes("index.ts") && files.includes("test/server.test.ts"), "the sweep reads the tree");
  assert.deepEqual(hitText(sweepTree(files, hasTerm)), []);
});

test("each term is caught, and the look-alikes are not", () => {
  // This file skips its own sweep, but a plain grep of the tree for the exact
  // phrases should still come back empty, so the samples are reworded or
  // assembled from pieces.
  for (const line of [
    `// Fixed in ${"ABC"}-123.`,
    `// Mirrors the ${HOME_LAB} config.`,
    "// The migration may change this.",
    "// Emitted by the cut-over.",
    "// Plex MCP v2 server.",
    "// the v1 gap",
    "// This row is 0.9.0 only.",
    `// Exists only for ${"0.9.0"}.`,
    "// Removed after launch.",
    "// Fixed pre-launch.",
    `// Something ${FIRST_NAME} has not signed off.`,
    `userInfo: user("${FIRST_NAME.toLowerCase()}"),`,
    `// Paging (${"verified"} live) needs both headers.`,
    "// Verified: Plex ignores it.",
    "// Verified 2026-07-07.",
    `// Kept for ${"back"}-compat.`,
    `// ${"Backwards"} compatible with the old shape.`,
    `// The first version stays for ${"back"}compat.`,
    `// ${"DO"} NOT merge these helpers.`,
    `// ${"CRITICAL"}: paging needs both headers.`,
    `// The ${"future"} runtime's boundary.`,
    `// Until a ${"Future"} release.`,
  ]) {
    assert.equal(narrationHits("x.ts", line).length, 1, line);
  }
  for (const line of [
    "/** Tautulli API v2 client. */",
    "/** plex.tv account API (v2). */",
    'const url = "/api/v2";',
    "uses: some-owner/some-repo/.github/workflows/x.yml@v1",
    "const IMAGE = \"ghcr.io/dustinhansen/plex-mcp\";",
    'const PACKAGE = "@dustinhansen/plex-mcp";',
    "assert.equal(tag, \"v1.0.0-rc.1\");",
    "// stdio: the client launches the server as a child process.",
    "// Returns the verified token.",
    "// Falls back to compact output.",
    "// Do not merge these helpers: the operators differ.",
    "// Runs inside a critical section.",
    "const futureDate = Date.now() + 1;",
    "// Resolves the futures in order.",
    "// Timestamps are ISO-8601.",
    "// Decodes UTF-8, and counts UTF-16 units.",
    "// The SHA-256 of the download.",
    "// Dates as RFC-7231 allows.",
    'contentRating: "PG-13",',
    "runs-on: ubuntu-24.04",
  ]) {
    assert.deepEqual(narrationHits("x.ts", line), [], line);
  }
});
