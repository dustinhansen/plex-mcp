// The runtime's strings and comments are written in the same voice as the
// docs (AGENTS.md), which keeps semicolons out of prose. Tool descriptions and
// prompts reach every client's model, and comments are what a reader of the
// code meets first, so this sweeps both in the tracked runtime sources for a
// semicolon. Code is not swept, because a semicolon there is TypeScript, not
// prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, RUNTIME_SOURCES, trackedFiles, type LineHit } from "./sweep.ts";

// After one of these, a slash opens a regex literal rather than dividing. A
// `++` or `--` ends an operand, and so does TypeScript's non-null `!` after a
// name or a bracket, so a slash after either divides. A keyword after a dot is
// a property name, and one after a `$` is part of a name, so a slash after
// `o.in` or `$in` divides too.
const BEFORE_REGEX =
  /(?:^|[(,=:[&|?{};*%<>~^]|(?<![\w$)\]])!|(?<!\+)\+|(?<!-)-|(?<![.$])\b(?:return|typeof|yield|await|void|delete|in|of|instanceof|else|do|case|throw|new))\s*$/;

/**
 * The lines of `source` with a semicolon in a string literal or a comment.
 * It scans the whole file, because a template literal or a block comment can
 * span lines. A `${}` inside a template is code, so a semicolon there passes.
 * A quote or regex left open at a line's end, or anything left open at the
 * file's end, throws: the scan has lost its place, and every hit after that
 * point would be missed.
 */
function semicolonsInProse(path: string, source: string): LineHit[] {
  const lines = source.split("\n");
  const hitLines = new Set<number>();
  // What the scanner is inside, and the line it opened on. Each `${}` records
  // the brace depth it opened at, so the brace that closes it returns to the
  // template, and the line its template opened on.
  type State = "code" | "line-comment" | "block-comment" | "regex" | '"' | "'" | "`";
  let state: State = "code";
  let opened = 0;
  const templates: Array<{ depth: number; opened: number }> = [];
  let depth = 0;
  let line = 0;
  // The tail of the code before this point, with each string or regex
  // standing in as "x", so a slash after an operand reads as division.
  let codeTail = "";
  const lost = (at: number, what: string) => new Error(`${path}:${at + 1} ${what}`);
  // Skips what a backslash escapes, counting a line it continues past.
  const skipEscaped = (i: number) => {
    if (source[i + 1] === "\r" && source[i + 2] === "\n") {
      line++;
      return i + 2;
    }
    if (source[i + 1] === "\n") line++;
    return i + 1;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") {
      if (state === '"' || state === "'" || state === "regex") throw lost(line, `a ${state} literal runs past the line`);
      line++;
      if (state === "line-comment") state = "code";
      if (state === "code") codeTail += ch;
      continue;
    }
    if (ch === ";" && state !== "code" && state !== "regex") hitLines.add(line);
    switch (state) {
      case "code":
        if (ch === "/" && next === "/") state = "line-comment";
        else if (ch === "/" && next === "*") state = "block-comment";
        else if (ch === "/" && BEFORE_REGEX.test(codeTail)) state = "regex";
        else if (ch === '"' || ch === "'" || ch === "`") state = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          if (templates.length > 0 && templates[templates.length - 1].depth === depth) {
            opened = templates.pop()!.opened;
            state = "`";
          } else depth--;
        }
        if (state === "code") codeTail = (codeTail + ch).slice(-40);
        else {
          if (ch !== "}") opened = line;
          if (state !== "line-comment" && state !== "block-comment") codeTail += "x";
        }
        break;
      case "block-comment":
        if (ch === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
      case "regex":
        if (ch === "\\") i = skipEscaped(i);
        else if (ch === "[") {
          while (i + 1 < source.length && source[i + 1] !== "]" && source[i + 1] !== "\n") {
            if (source[++i] === "\\") i = skipEscaped(i);
          }
        } else if (ch === "/") state = "code";
        break;
      case '"':
      case "'":
        if (ch === "\\") i = skipEscaped(i);
        else if (ch === state) state = "code";
        break;
      case "`":
        if (ch === "\\") i = skipEscaped(i);
        else if (ch === "`") state = "code";
        else if (ch === "$" && next === "{") {
          templates.push({ depth, opened });
          state = "code";
          codeTail = "{";
          i++;
        }
        break;
    }
  }
  if (state === "code" && templates.length > 0) throw lost(templates[0].opened, "a template is never closed");
  if (state !== "code" && state !== "line-comment") throw lost(opened, `a ${state} is never closed`);
  return [...hitLines].map((i) => ({ path, line: i + 1, text: lines[i] }));
}

const hitText = (hits: LineHit[]) => hits.map(({ path, line, text }) => `${path}:${line} ${text.trim()}`);
const semicolonHits = (source: string) => hitText(semicolonsInProse("x.ts", source));

test("no string literal or comment in a tracked runtime source has a semicolon", () => {
  const files = trackedFiles(RUNTIME_SOURCES);
  assert.ok(
    files.includes("index.ts") && files.includes("lib/tools-read.ts") && files.includes("smoke.ts"),
    "the sweep reads the tree",
  );
  const hits = files.flatMap((path) => semicolonsInProse(path, readFileSync(join(repoRoot, path), "utf8")));
  assert.deepEqual(hitText(hits), []);
});

test("a semicolon in a string or a comment is caught, and one in code is not", () => {
  for (const line of [
    'describe("Defaults to 3 picks; combine filters.");',
    "describe('Explicit keys only; marking watched records a play.');",
    "const text = `Candidates first; then ${pick}.`;",
    "const text = `${a}; ${b}`;",
    "const text = `first line\nsecond; line`;",
    "const x = y\n/ 2; const s = 'a;';",
    "const v = a++ / 2; const s = 'a;';",
    'const r = a! / b; const s = "a;"; const q = c / d;',
    'const r = o.in / b; const s = "a;"; const q = c / d;',
    'const r = $in / b; const s = "a;"; const q = c / d;',
    "// Pick first; then sort.",
    "/* Pick first; then sort. */",
    "/**\n * Pick first; then sort.\n */",
    "const n = 1; // Pick first; then sort.",
    "const text = `a${ /* pick first; then sort */ x }c`;",
  ]) {
    assert.equal(semicolonHits(line).length, 1, line);
  }
  for (const line of [
    'const picks = describe("Defaults to 3 picks. Combine filters.");',
    "for (;;) break;",
    "for (let i = 0; i < 3; i++) total += i;",
    "// Pick first. Then sort.",
    "/**\n * Pick first. Then sort.\n */",
    'const s = "a // b"; const t = 1;',
    "const n = 1; /* one */ const m = 2;",
    'const s = "say \\"hi\\""; const t = 1;',
    "const text = `count: ${items.map((x) => { return x; }).length}`;",
    "const ok = /[\"';]/.test(s); const n = a / b; const m = c / d;",
    "function* g() { yield /re';/; }",
    "const ok = !/[';]/.test(s);",
    "const src = `${/a;/.source}`;",
    'const s = "first \\\r\nsecond";',
  ]) {
    assert.deepEqual(semicolonHits(line), [], line);
  }
});

test("a scan that loses its place throws rather than missing what follows", () => {
  assert.throws(() => semicolonHits('const s = "never closed\nconst t = "a;";'), /x\.ts:1 a " literal runs past the line/);
  assert.throws(() => semicolonHits("const a = 1;\nconst t = `never closed;\n\n"), /x\.ts:2 a ` is never closed/);
  assert.throws(() => semicolonHits("const a = 1;\nconst t = `${x\n\n"), /x\.ts:2 a template is never closed/);
  assert.throws(() => semicolonHits("`a\n${`b\n${c}`}\n${ d"), /x\.ts:1 a template is never closed/);
});
