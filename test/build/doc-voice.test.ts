// The public docs are written in one plain first-person voice (AGENTS.md).
// This sweeps every tracked Markdown file, and the issue forms a reporter
// reads, for the phrasings that mark generated prose, for semicolons, and for
// em dashes and dates, which belong in CHANGELOG headings only. A form is
// read line by line like any doc, keys and all, so its structure passes only
// while no key or comment trips a rule.
// Fenced and inline code are skipped. Each line is read with the next one
// joined on, so a phrase the hard wrap splits is still caught. It reads the
// literal text, so a tell phrased some other way is for review to catch.
//
// The npm and registry listings, and the comments a self-hoster reads in
// .env.example, take the same rules. Only their prose is read: the
// description strings of the 2 JSON files, parsed, and the env file's
// comments. A raw package.json line can be a script, where a semicolon is
// shell, and server.json lines carry URLs and example values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, trackedFiles } from "./sweep.ts";

const TELLS: Array<[tell: string, pattern: RegExp]> = [
  ["a passive decision", /\b(?:was|were|been)\s+(?:rejected|considered|chosen|decided)\b|\bit was decided\b/gi],
  // Case-sensitive, so the dustinhansen account in package and image names
  // does not match.
  ["a third-person reference to me", /\bDustin\b|\b[Tt]he maintainer\b/g],
  ["deliberate", /\bdeliberate/gi],
  ["robust", /\brobust/gi],
  ["seamless", /\bseamless/gi],
  ["leverage", /\bleverag/gi],
  ["ensure that", /\bensur(?:e|es|ed|ing)\s+that\b/gi],
  // A sentence that opens with it, so "a release note that lists changes"
  // passes, even when the wrap puts "note" at the start of a line.
  ["note that", /(?<=^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?[(*_]*|[.!?:]\s+[(*_]*)Note\s+that\b/g],
  ["it's worth noting", /\bit[’']?s\s+worth\s+noting\b/gi],
  ["importantly", /\bimportantly\b/gi],
  ["a summing-up opener", /\bin\s+(?:summary|conclusion)\b|\bat\s+the\s+end\s+of\s+the\s+day\b/gi],
  ["a stock connective", /\b(?:moreover|furthermore|additionally)\b/gi],
  ["utilize", /\butiliz/gi],
  ["streamline", /\bstreamlin/gi],
  ["comprehensive", /\bcomprehensive/gi],
  ["an inflated word", /\b(?:crucial|pivotal|impactful|game-changing|meticulous|holistic|synergy|tapestry|nuanced|empower|foster)/gi],
  ["delve", /\bdelv(?:e|es|ing)\b/gi],
  ["a stock pleasantry", /\b(?:dive\s+in|hope\s+this\s+helps|happy\s+to\s+help|feel\s+free\s+to|don[’']?t\s+hesitate)\b/gi],
  ["not only ... but also", /\bnot\s+only\b.*\bbut\s+also\b/gi],
];

// MCP protocol revisions are named by date. They identify a spec, not when
// something happened here.
const PROTOCOL_REVISIONS = new Set(["2025-11-25", "2026-07-28"]);

// Capitalized only, so the verb "may" is not a month.
const MONTH =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December" +
  "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?(?![a-z])";

const DATES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "g"),
  new RegExp(`\\b${MONTH},?\\s+\\d{4}\\b`, "g"),
];

const EM_DASH = "\u2014";

// Any indent, so a fence nested under a list item counts too.
const FENCE = /^\s*(`{3,}|~{3,})/;

// The file's lines with fenced code blanked out and inline code spans
// replaced by a space, plus the line of a fence that never closes.
function proseLines(lines: string[]) {
  const prose: string[] = [];
  let fence = "";
  let opened = 0;
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (!fence) {
      if (marker) {
        fence = marker;
        opened = i + 1;
        prose.push("");
      } else {
        prose.push(line.replace(/`[^`]*`/g, " "));
      }
      return;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
    prose.push("");
  });
  return { prose, unclosed: fence ? opened : 0 };
}

// Matches of `pattern` that start on this line, reading on into the next.
function startingHere(pattern: RegExp, line: string, next: string) {
  return [...`${line} ${next}`.matchAll(pattern)]
    .filter((m) => m.index < line.length)
    .map((m) => m[0].replace(/\s+/g, " "));
}

function voiceHits(path: string, source: string) {
  const isChangelog = path === "CHANGELOG.md" || path.endsWith("/CHANGELOG.md");
  const lines = source.split("\n");
  const { prose, unclosed } = proseLines(lines);
  const hits: string[] = [];
  prose.forEach((text, i) => {
    if (!text) return;
    const at = `${path}:${i + 1}`;
    const next = prose[i + 1] ?? "";
    const original = lines[i].trim();
    for (const [tell, pattern] of TELLS) {
      for (const match of startingHere(pattern, text, next)) hits.push(`${at} ${tell} ("${match}"): ${original}`);
    }
    if (text.includes(";")) hits.push(`${at} a semicolon: ${original}`);
    if (isChangelog && /^#{1,6}\s/.test(text)) return;
    if (text.includes(EM_DASH)) hits.push(`${at} an em dash: ${original}`);
    const dates = new Set(DATES.flatMap((pattern) => startingHere(pattern, text, next)));
    for (const date of dates) {
      if (!PROTOCOL_REVISIONS.has(date)) hits.push(`${at} a date ("${date}"): ${original}`);
    }
  });
  if (unclosed) hits.push(`${path}:${unclosed} a code fence that never closes`);
  return hits;
}

test("no tracked Markdown file or issue form carries a generated-prose tell, a semicolon, an em dash or a stray date", () => {
  const files = trackedFiles(["*.md", ".github/ISSUE_TEMPLATE/*.yml", ".github/ISSUE_TEMPLATE/*.yaml"]);
  assert.ok(files.includes("README.md") && files.includes("docs/publishing.md"), "the sweep reads the tree");
  assert.ok(files.includes(".github/ISSUE_TEMPLATE/bug_report.yml"), "the sweep reads the issue forms");
  assert.deepEqual(files.flatMap((path) => voiceHits(path, readFileSync(join(repoRoot, path), "utf8"))), []);
});

// Every `description` string under `value`, keyed by its JSON path, so a new
// field in server.json is read without a test edit.
function descriptions(value: unknown, at: string): Array<[path: string, text: string]> {
  if (Array.isArray(value)) return value.flatMap((item, i) => descriptions(item, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]): Array<[string, string]> => {
    const path = at ? `${at}.${key}` : key;
    return key === "description" && typeof item === "string" ? [[path, item]] : descriptions(item, path);
  });
}

// The prose comments of an env file with their `#` stripped, so a phrase
// the wrap splits still joins up. A commented-out assignment is a value, not
// prose, and every other line is blanked so a hit keeps its line number.
function envComments(source: string) {
  return source
    .split("\n")
    .map((line) => {
      const comment = /^\s*#\s*(.*)$/.exec(line)?.[1];
      return comment === undefined || /^[A-Z][A-Z0-9_]*=/.test(comment) ? "" : comment;
    })
    .join("\n");
}

function listingHits(packageJson: string, serverJson: string, envExample: string) {
  const { description } = JSON.parse(packageJson) as { description?: unknown };
  return [
    ...(typeof description === "string" ? voiceHits("package.json description", description) : ["package.json has no description"]),
    ...descriptions(JSON.parse(serverJson), "").flatMap(([path, text]) => voiceHits(`server.json ${path}`, text)),
    ...voiceHits(".env.example", envComments(envExample)),
  ];
}

test("the npm and registry listings and .env.example's comments take the same rules", () => {
  const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
  const server = read("server.json");
  assert.ok(descriptions(JSON.parse(server), "").length > 1, "the check reads server.json's descriptions");
  assert.deepEqual(listingHits(read("package.json"), server, read(".env.example")), []);
});

test("a listing's prose fails on a tell, and its scripts and other fields do not", () => {
  const pkg = (description: string) =>
    JSON.stringify({ description, scripts: { test: "npm ci; npm test" }, homepage: "https://example.com/a;b" });
  const server = (description: string) =>
    JSON.stringify({ packages: [{ environmentVariables: [{ name: "PLEX_URL", description, default: "a;b" }] }] });
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), server("Plex base URL."), "# One.\nX=a;b\n"), []);
  assert.deepEqual(listingHits(pkg("MCP server \u2014 for Plex."), server("Plex base URL."), ""), [
    "package.json description:1 an em dash: MCP server \u2014 for Plex.",
  ]);
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), server("Plex base URL \u2014 with port."), ""), [
    "server.json packages[0].environmentVariables[0].description:1 an em dash: Plex base URL \u2014 with port.",
  ]);
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), server("Plex base URL."), "X=1\n# Port; inside the container.\n"), [
    ".env.example:2 a semicolon: Port; inside the container.",
  ]);
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), server("Plex base URL."), "# This will ensure\n# that it pages.\n"), [
    '.env.example:1 ensure that ("ensure that"): This will ensure',
  ]);
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), server("Plex base URL."), "# X=a;b\n#   PORT=1;2\n"), []);
  assert.deepEqual(listingHits("{}", server("Plex base URL."), ""), ["package.json has no description"]);
  assert.deepEqual(listingHits(pkg("MCP server for Plex."), JSON.stringify({ description: "Plex; for agents." }), ""), [
    "server.json description:1 a semicolon: Plex; for agents.",
  ]);
});

test("each tell is caught, and the look-alikes are not", () => {
  // The narration sweep reads this file and fails on the name, so that
  // sample is assembled.
  const me = ["Dus", "tin"].join("");
  for (const line of [
    "This was rejected because it leaks the token.",
    "Two transports were considered.",
    "It was decided to keep one image.",
    `${me} chose stdio.`,
    "Ask the maintainer first.",
    "The maintainer reviews PRs.",
    "The surface is deliberately small.",
    "A robust retry loop.",
    "Seamless sign-in.",
    "We leverage the SDK.",
    "This ensures that writes name a target.",
    "Ensuring that writes name a target.",
    "Note that the token is secret.",
    "- Note that the token is secret.",
    "It pages. Note that the cap is 100.",
    "> **Note that** the cap is 100.",
    "(Note that the cap is 100.)",
    "It's worth noting the cap.",
    "Importantly, reads are free.",
    "In summary, it works.",
    "At the end of the day, it pages.",
    "Moreover, it pages.",
    "We utilize the cache.",
    "A streamlined setup.",
    "A comprehensive surface.",
    "This is crucial.",
    "It empowers the client.",
    "Let us delve into paging.",
    "Let's dive in.",
    "Feel free to open an issue.",
    "It not only reads but also writes.",
  ]) {
    assert.equal(voiceHits("README.md", line).length, 1, line);
  }
  for (const line of [
    "I rejected a second image because it doubles the release.",
    "ghcr.io/dustinhansen/plex-mcp",
    "The server owner's token.",
    "Writes name their targets.",
    "Support for Node 20 has been dropped.",
    "Each release gets a note that lists changes.",
    "note that lists changes.",
    "It implements MCP protocol revision 2025-11-25.",
    "`addedSince` takes an ISO date such as `2026-01-01`.",
    "Set `robust: true` to retry.",
    "A client may 2 or 3 times retry.",
    "## Unreleased",
  ]) {
    assert.deepEqual(voiceHits("README.md", line), [], line);
  }
});

test("a tell split by the hard wrap is caught once, on the line it starts", () => {
  assert.deepEqual(voiceHits("README.md", "A second image was\nrejected. It doubles the release."), [
    'README.md:1 a passive decision ("was rejected"): A second image was',
  ]);
  assert.equal(voiceHits("README.md", "This will\nensure that it pages.").length, 1);
  assert.equal(voiceHits("README.md", "It pages. Note\nthat the cap is 100.").length, 1);
});

test("a date fails anywhere but a CHANGELOG heading", () => {
  const dated = "2026-01-02";
  assert.deepEqual(voiceHits("CHANGELOG.md", `## 0.9.0 — ${dated}`), []);
  assert.equal(voiceHits("CHANGELOG.md", `- Fixed on ${dated}.`).length, 1);
  assert.equal(voiceHits("README.md", `## Design notes\n\nI chose this on ${dated}.`).length, 1);
  for (const line of [
    "I chose this on January 2, 2026.",
    "I chose this on 2 Jan 2026.",
    "I chose this in October 2026.",
    "I chose this on 1/2/2026.",
  ]) {
    assert.equal(voiceHits("README.md", line).length, 1, line);
  }
});

test("an em dash fails anywhere but a CHANGELOG heading or code", () => {
  assert.deepEqual(voiceHits("CHANGELOG.md", "## 0.9.0 \u2014 <date>"), []);
  assert.equal(voiceHits("CHANGELOG.md", "- Fixed paging \u2014 the cap was off by one.").length, 1);
  assert.equal(voiceHits("README.md", "## 0.9.0 \u2014 <date>").length, 1);
  assert.equal(voiceHits("README.md", "It pages \u2014 100 at a time.").length, 1);
  assert.deepEqual(voiceHits("README.md", "| `random_pick` | Picks one item \u2014 or several. |"), [
    "README.md:1 an em dash: | `random_pick` | Picks one item \u2014 or several. |",
  ]);
  assert.deepEqual(voiceHits("README.md", "Turn it into `## <version> \u2014 <date>`."), []);
  assert.deepEqual(voiceHits("README.md", "```sh\nnpm run smoke  # live \u2014 needs PLEX_URL\n```"), []);
  assert.deepEqual(voiceHits("README.md", "Pages run 1-50, then seasons 1\u20133."), []);
});

test("a semicolon fails anywhere but code", () => {
  assert.deepEqual(voiceHits("README.md", "It pages; the cap is 100."), ["README.md:1 a semicolon: It pages; the cap is 100."]);
  assert.deepEqual(voiceHits("README.md", "| `random_pick` | Picks one item; or several. |"), [
    "README.md:1 a semicolon: | `random_pick` | Picks one item; or several. |",
  ]);
  assert.equal(voiceHits("CHANGELOG.md", "## 0.9.0; <date>").length, 1);
  assert.deepEqual(voiceHits("README.md", "Run `npm ci; npm test` first."), []);
  assert.deepEqual(voiceHits("README.md", "```sh\nfor p in a b; do echo $p; done\n```"), []);
});

test("an issue form's prose takes the same rules, and its YAML structure passes", () => {
  const form = ".github/ISSUE_TEMPLATE/bug_report.yml";
  assert.deepEqual(voiceHits(form, "      description: It pages — 100 at a time."), [
    `${form}:1 an em dash: description: It pages — 100 at a time.`,
  ]);
  assert.deepEqual(voiceHits(form, "      description: It pages; the cap is 100."), [
    `${form}:1 a semicolon: description: It pages; the cap is 100.`,
  ]);
  assert.deepEqual(voiceHits(form, "      value: |\n        Feel free to open one."), [
    `${form}:2 a stock pleasantry ("Feel free to"): Feel free to open one.`,
  ]);
  assert.deepEqual(
    voiceHits(form, 'name: Bug report\nlabels: ["needs-triage"]\nbody:\n  - type: textarea\n    validations:\n      required: true'),
    [],
  );
});

test("fenced code is skipped, and a fence that never closes fails", () => {
  assert.deepEqual(voiceHits("README.md", "```sh\n# was rejected 2026-01-02\n```"), []);
  assert.deepEqual(voiceHits("README.md", "````md\n```\nNote that.\n````"), []);
  assert.deepEqual(voiceHits("README.md", "~~~\n```\nNote that.\n~~~"), []);
  assert.equal(voiceHits("README.md", "```sh\nx\n```\nNote that it ran.").length, 1);
  assert.deepEqual(voiceHits("README.md", "Text.\n```sh\nx"), ["README.md:2 a code fence that never closes"]);
  assert.deepEqual(voiceHits("docs/publishing.md", "- [ ] Run it:\n\n      ```sh\n      for p in a b; do echo $p; done\n      ```"), []);
});

test("a failure names the file, line and tell", () => {
  assert.deepEqual(voiceHits("docs/docker.md", "First line.\nThis was rejected."), [
    'docs/docker.md:2 a passive decision ("was rejected"): This was rejected.',
  ]);
});
