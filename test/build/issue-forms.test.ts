// An issue form's `labels:` only takes effect when the repository already has
// each label, and GitHub drops a missing one without saying so. So every label
// a form names is either one GitHub creates in a new repository and
// docs/publishing.md's Repository settings leave alone, or one they create with
// `gh label create`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const formsDir = join(repoRoot, ".github/ISSUE_TEMPLATE");
const publishing = readFileSync(join(repoRoot, "docs/publishing.md"), "utf8");

// The labels every new repository starts with. GitHub has added to this list
// over time, so a newer default missing here fails the sweep rather than
// slipping through it.
const githubDefaults = new Set([
  "accessibility", "bug", "documentation", "duplicate", "enhancement",
  "good first issue", "help wanted", "invalid", "question", "wontfix",
]);

type Form = { name: string; source: string };

function forms(): Form[] {
  return readdirSync(formsDir)
    .filter((name) => /\.ya?ml$/.test(name) && name !== "config.yml")
    .sort()
    .map((name) => ({ name, source: readFileSync(join(formsDir, name), "utf8") }));
}

// Every form with `extra` appended to its needs-triage list.
function formsWith(extra: string): Form[] {
  return forms().map((form) => {
    const source = form.source.replace('["needs-triage"]', `["needs-triage", ${extra}]`);
    assert.notEqual(source, form.source, `${form.name} has no ["needs-triage"] list`);
    return { ...form, source };
  });
}

// Reads only the one-line flow list (`labels: ["a", "b"]`) the forms use. Any
// other shape reads as no labels, which the first test below fails on.
function formLabels(source: string): string[] {
  const line = source.match(/^labels:[ \t]*\[(.*)\][ \t]*$/m);
  if (!line) return [];
  return line[1].split(",").map((label) => label.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// A name is either one bare word or a double-quoted phrase ("help wanted").
function labelsAfter(doc: string, command: "create" | "delete"): Set<string> {
  const line = new RegExp(`^gh label ${command} (?:"([^"]+)"|(\\S+))`, "gm");
  return new Set([...doc.matchAll(line)].map((m) => m[1] ?? m[2]));
}

// Each form label the repository won't have: not a GitHub default the doc
// leaves alone, and not one the doc creates.
function missingLabels(all: Form[], doc: string): string[] {
  const created = labelsAfter(doc, "create");
  const deleted = labelsAfter(doc, "delete");
  const exists = (label: string) =>
    created.has(label) || (githubDefaults.has(label) && !deleted.has(label));
  return all.flatMap(({ name, source }) =>
    formLabels(source)
      .filter((label) => !exists(label))
      .map((label) => `${name}: ${label}`),
  );
}

test("every form names at least one label, so the sweep below has something to check", () => {
  const all = forms();
  assert.ok(all.length > 0);
  for (const { name, source } of all) {
    assert.ok(formLabels(source).length > 0, `${name} names no labels`);
  }
});

test("every label an issue form applies is created by publishing.md, or ships with GitHub and isn't deleted there", () => {
  assert.deepEqual(missingLabels(forms(), publishing), []);
});

test("a form label the doc stops creating is caught", () => {
  const without = publishing.replace(/^gh label create needs-triage/m, "gh label create something-else");
  assert.notEqual(without, publishing);
  assert.deepEqual(missingLabels(forms(), without), [
    "bug_report.yml: needs-triage",
    "feature_request.yml: needs-triage",
  ]);
});

test("a form label nobody creates is caught", () => {
  assert.deepEqual(missingLabels(formsWith('"triaged"'), publishing), [
    "bug_report.yml: triaged",
    "feature_request.yml: triaged",
  ]);
});

test("a form naming a default the doc deletes is caught", () => {
  assert.deepEqual(missingLabels(formsWith('"help wanted", "wontfix"'), publishing), [
    "bug_report.yml: help wanted",
    "feature_request.yml: help wanted",
  ]);
});
