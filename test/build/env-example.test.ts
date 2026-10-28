// .env.example is the template docs/docker.md's local build reads with
// `--env-file .env`, so it names every variable the README's Environment
// variables table lists. The 3 the image needs are set to placeholders, and
// every other variable is a commented line with the value the image runs with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const example = readFileSync(join(repoRoot, ".env.example"), "utf8");

type Row = { names: string[]; required: string };

// The table under the section's heading, past its header and separator rows.
// A row's first column can name more than one variable, as the Tautulli pair
// does.
function tableRows(doc: string): Row[] {
  const section = doc.split(/^## Environment variables$/m)[1]?.split(/^## /m)[0] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("|")).slice(2);
  return rows.map((row) => {
    const cells = row.split("|");
    return { names: [...cells[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]), required: cells[2].trim() };
  });
}

function tableVariables(doc: string): string[] {
  return tableRows(doc).flatMap((row) => row.names).sort();
}

// The image runs http mode, so it needs every variable whose "required" cell
// is not "no": the ones required always and the one required in http mode.
function imageNeeds(doc: string): string[] {
  return tableRows(doc).filter((row) => row.required !== "no").flatMap((row) => row.names).sort();
}

type Entry = { name: string; commented: boolean };

// A `NAME=value` line, set or commented out. Comment lines that hold no
// assignment are prose.
function exampleEntries(file: string): Entry[] {
  return [...file.matchAll(/^(#[ \t]*)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => ({ name: m[2], commented: Boolean(m[1]) }));
}

// Each variable in one and not the other, with where it is missing from.
function mismatches(doc: string, file: string): string[] {
  const table = new Set(tableVariables(doc));
  const listed = new Set(exampleEntries(file).map((entry) => entry.name));
  return [
    ...[...table].filter((name) => !listed.has(name)).map((name) => `${name}: not in .env.example`),
    ...[...listed].filter((name) => !table.has(name)).map((name) => `${name}: not in the README table`),
  ].sort();
}

test("the README table yields the variables, so the comparison has something to check", () => {
  assert.ok(tableVariables(readme).includes("TAUTULLI_API_KEY"));
  assert.deepEqual(imageNeeds(readme), ["MCP_PATH_SECRET", "PLEX_TOKEN", "PLEX_URL"]);
});

test(".env.example names every variable in the README table, and no other", () => {
  assert.deepEqual(mismatches(readme, example), []);
});

test("each variable appears once, set only for the 3 the image needs", () => {
  const entries = exampleEntries(example);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length);
  assert.deepEqual(entries.filter((entry) => !entry.commented).map((entry) => entry.name).sort(), imageNeeds(readme));
});

test("a variable the README adds and the example lacks is caught", () => {
  const added = readme.replace(/^\| `PORT` \|/m, "| `MCP_LOG_LEVEL` | no | log level |\n| `PORT` |");
  assert.notEqual(added, readme);
  assert.deepEqual(mismatches(added, example), ["MCP_LOG_LEVEL: not in .env.example"]);
});

test("a variable the example drops or invents is caught", () => {
  const changed = example.replace(/^# PORT=.*$/m, "# LISTEN_PORT=8627");
  assert.notEqual(changed, example);
  assert.deepEqual(mismatches(readme, changed), ["LISTEN_PORT: not in the README table", "PORT: not in .env.example"]);
});
