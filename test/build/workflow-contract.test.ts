// The safety contract for .github/workflows/, read from the raw YAML source
// rather than a full parser, so it needs no dependency and reads in one file.
// A floating action tag, a job with no timeout, a trigger that hands fork code
// the base repository's context, or a token broader than it needs changes
// nothing visible until it is misused, so the PR that introduces one is the
// only reliable place to catch it.
//
// Each guarantee is a sweep that returns its violations, asserted empty over
// the real tree and shown to fail on a mutation of the real files, so a sweep
// that has quietly stopped matching anything cannot pass for one that holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowsDir = join(repoRoot, ".github/workflows");

type Block = { inline: string; body: string };
type Sweep = (dir: string) => string[];
type GrantRow = [file: string, job: string, scope: string];
type SecretRow = [job: string, secret: string];
type SecretRead = { label: string; secret?: string };
type Mutation = [name: string, from: string, to: string, sweep: Sweep, expected: string | string[]];

function workflowFiles(dir: string) {
  return readdirSync(dir).sort();
}

// Every workflow file's name and raw source, in sorted order: the one place
// the sweeps below read the directory.
function* eachWorkflow(dir: string) {
  for (const name of workflowFiles(dir)) {
    yield { name, source: readFileSync(join(dir, name), "utf8") };
  }
}

// The lines directly under a `key:` declared at `indent` spaces, stopping at
// the next line whose own indent is no deeper. A blank line or a comment does
// not end the block, since YAML lets either sit anywhere inside one, and a
// comment at the key's own indent would otherwise hide the grant below it.
// `inline` is whatever follows the key on its own line.
function childBlock(source: string, key: string, indent: number): Block | null {
  const prefix = " ".repeat(indent);
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line === `${prefix}${key}:` || line.startsWith(`${prefix}${key}: `));
  if (at === -1) return null;

  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && !line.trim().startsWith("#") && line.match(/^ */)![0].length <= indent) break;
    body.push(line);
  }
  return { inline: lines[at].slice(prefix.length + key.length + 1).trim(), body: body.join("\n") };
}

// Each job under `jobs:`, as its key and the raw text of its own block. A
// quoted key or a trailing comment on the header is still a header: without
// that, `deploy: # why` folds into the job above and its grants are never
// read.
function jobBlocks(source: string) {
  const jobsBlock = childBlock(source, "jobs", 0);
  if (jobsBlock === null) return [];

  const jobs: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of jobsBlock.body.split("\n")) {
    const header = line.match(/^ {2}["']?([A-Za-z0-9_-]+)["']?:(?:\s+#.*)?\s*$/);
    if (header) {
      if (current) jobs.push(current);
      current = { name: header[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) jobs.push(current);
  return jobs.map((job) => ({ name: job.name, body: job.lines.join("\n") }));
}

// A `key:` block's entries as trimmed lines, the inline form included. Null
// when the key is absent, which callers distinguish from an empty block.
// Comment lines are dropped, so a note inside a block is not an entry.
function blockEntries(block: Block | null) {
  if (block === null) return null;
  return [block.inline, ...block.body.split("\n").map((line) => line.trim())].filter(
    (entry) => entry !== "" && !entry.startsWith("#"),
  );
}

// Every `uses:` line in a workflow, wherever it sits: a step's action, or a
// job's call into a reusable workflow (no leading `-`). `value` is the
// reference before any trailing comment; `comment` is what follows `#`.
function usesLines(source: string) {
  return [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)(?:\s+#\s*(.+?))?\s*$/gm)]
    .map(([, value, comment]) => ({ value, comment }));
}

// A job that hands its work to a reusable workflow: `uses:` at job level.
// GitHub rejects `runs-on` and `timeout-minutes` on such a job, since the
// called workflow owns them, so the job-key sweep exempts it.
function callsSharedWorkflow(jobBody: string) {
  return /^ {4}uses:/m.test(jobBody);
}

// owner/repo@<sha>, or owner/repo/<path to a reusable workflow>@<sha>, with
// the version the SHA resolves to in a trailing comment. A reusable workflow
// in this repository (`./.github/workflows/x.yml`) has no SHA to pin.
const SHA_PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+(\.\d+\.\d+)?$/;

function pinViolations(dir: string) {
  const violations: string[] = [];
  for (const { name, source } of eachWorkflow(dir)) {
    for (const { value, comment } of usesLines(source)) {
      if (value.startsWith("./")) continue;
      if (!SHA_PINNED.test(value)) {
        violations.push(`${name}: "${value}" is not pinned to a full commit SHA`);
      } else if (!comment || !VERSION_COMMENT.test(comment)) {
        violations.push(`${name}: "${value}" is SHA-pinned but has no trailing "# vX.Y.Z" comment naming the version`);
      }
    }
  }
  return violations;
}

// A job with no timeout runs for GitHub's six-hour default when it hangs, and
// one with no runs-on is a workflow GitHub refuses to run.
function jobKeyViolations(dir: string) {
  const violations: string[] = [];
  for (const { name, source } of eachWorkflow(dir)) {
    for (const job of jobBlocks(source)) {
      if (callsSharedWorkflow(job.body)) continue;
      for (const key of ["timeout-minutes", "runs-on"]) {
        if (!new RegExp(`^ {4}${key}:[ \\t]*[^\\s#]`, "m").test(job.body)) {
          violations.push(`${name} job "${job.name}" declares no ${key}`);
        }
      }
    }
  }
  return violations;
}

// Triggers that run fork-initiated work with the base repository's token and
// secrets, matched outside comments.
const FORK_EXPOSED_TRIGGER = /^[^#\n]*\b(pull_request_target|workflow_run)\b/m;

function triggerViolations(dir: string) {
  const violations: string[] = [];
  for (const { name, source } of eachWorkflow(dir)) {
    const trigger = source.match(FORK_EXPOSED_TRIGGER);
    if (trigger) {
      violations.push(`${name} triggers on ${trigger[1]}, which runs fork-initiated work with base-repository access`);
    }
  }
  return violations;
}

// A pull_request trigger with no branches: filter runs on a PR into any
// branch, and a PR-triggered workflow that never cancels in progress queues a
// redundant run behind every push to the PR branch. The list forms
// (`on: pull_request`, `on: [pull_request, push]`, or `- pull_request` under
// `on:`) can carry no filter, so they count as an unfiltered trigger.
const withoutComment = (text: string) => text.replace(/\s*#.*$/, "").trim();

function pullRequestViolations(dir: string) {
  const violations: string[] = [];
  for (const { name, source } of eachWorkflow(dir)) {
    const on = childBlock(source, "on", 0);
    if (on === null) continue;
    const listed =
      /\bpull_request\b/.test(withoutComment(on.inline)) || /^ {2}- *["']?pull_request["']?\s*(#.*)?$/m.test(on.body);
    const pullRequest = childBlock(on.body, "pull_request", 2);
    if (!listed && pullRequest === null) continue;
    if (listed || !(/^ {4}branches:/m.test(pullRequest!.body) || /\bbranches\s*:/.test(withoutComment(pullRequest!.inline)))) {
      violations.push(`${name} triggers on pull_request with no branches: filter`);
    }
    const cancel = childBlock(source, "concurrency", 0)?.body.match(/^ {2}cancel-in-progress:(.*)$/m);
    const value = cancel ? withoutComment(cancel[1]).replace(/^["']|["']$/g, "") : "";
    if (value === "" || value === "false") {
      violations.push(`${name} triggers on pull_request but never cancels a superseded run`);
    }
  }
  return violations;
}

// The scopes a permissions: block grants write. The inline forms count too:
// `write-all` grants every scope at once, and a flow mapping
// (`{ contents: write }`) is the same grant in braces, on one line or
// wrapped. Trailing comments go first, so one after the closing brace cannot
// hide it. An absent block grants nothing of its own.
function writeScopes(block: Block | null) {
  const entries = (blockEntries(block) ?? []).map((entry) => entry.replace(/\s+#.*$/, ""));
  const flow = entries.join(" ").match(/^\{(.*)\}$/);
  const scopes: string[] = [];
  for (const pair of flow ? flow[1].split(",") : entries) {
    const text = pair.trim();
    if (/^["']?write-all["']?$/.test(text)) scopes.push("write-all");
    const grant = text.match(/^["']?([\w-]+)["']?\s*:\s*["']?write["']?$/);
    if (grant) scopes.push(grant[1]);
  }
  return scopes;
}

const scopeLabel = (scope: string) => (scope === "write-all" ? "write-all" : `${scope}: write`);

// Every workflow states its default token, and that default is read-only. A
// workflow with no permissions: block gets whatever the repository setting
// says, which can be write, and a write default reaches every job, including
// ones added later without anyone deciding they need it.
function defaultPermissionViolations(dir: string) {
  const violations: string[] = [];
  for (const { name, source } of eachWorkflow(dir)) {
    const block = childBlock(source, "permissions", 0);
    if (block === null) {
      violations.push(`${name} declares no workflow-level permissions:, so its default token is the repository's`);
      continue;
    }
    for (const scope of writeScopes(block)) {
      violations.push(`${name} grants ${scopeLabel(scope)} at workflow level, where only read is allowed`);
    }
  }
  return violations;
}

// Every job-level write grant in the repository, as (workflow file, job,
// scope). Adding a row is the review: it is the diff that shows a job gaining
// a write token. Only release.yml writes: npm and the registry log in through
// OIDC, the image legs push by digest, and the job that names the image also
// signs its attestation, which takes an OIDC token too.
const WRITE_ALLOWLIST: GrantRow[] = [
  ["release.yml", "npm", "id-token"],
  ["release.yml", "image-build", "packages"],
  ["release.yml", "image", "packages"],
  ["release.yml", "image", "attestations"],
  ["release.yml", "image", "id-token"],
  ["release.yml", "registry", "id-token"],
];

const grantKey = (file: string, job: string, scope: string) => `${file} › ${job} › ${scope}`;

// A job's write scope with no allowlist row fails, and so does a row whose job
// no longer grants it, so the allowlist cannot outlive the grant it names. A
// row naming a workflow that is not in the swept directory is stale too.
function writeScopeViolations(dir: string, allowlist: GrantRow[] = WRITE_ALLOWLIST) {
  const allowed = new Set(allowlist.map((row) => grantKey(...row)));
  const violations: string[] = [];
  const granted = new Set<string>();
  for (const { name, source } of eachWorkflow(dir)) {
    for (const job of jobBlocks(source)) {
      for (const scope of writeScopes(childBlock(job.body, "permissions", 4))) {
        granted.add(grantKey(name, job.name, scope));
        if (!allowed.has(grantKey(name, job.name, scope))) {
          violations.push(`${name} job "${job.name}" grants ${scopeLabel(scope)}, which is not on the write-scope allowlist`);
        }
      }
    }
  }
  for (const [file, jobName, scope] of allowlist) {
    if (!granted.has(grantKey(file, jobName, scope))) {
      violations.push(`${file} job "${jobName}" does not grant ${scopeLabel(scope)}, so its write-scope allowlist row is stale`);
    }
  }
  return violations;
}

// The checks a pull request reports, by the names GitHub gives them: the job
// key, plus the value in parentheses for a one-axis matrix. A required-check
// ruleset matches these names, so a renamed job, a dropped matrix leg or a
// name: override leaves the ruleset waiting on a check that never reports.
// A job-level if: can skip a check, which a ruleset reads as passed.
const CI = "ci.yml";
const CHECK_NAMES = [
  "build",
  "artifact-smoke (22)",
  "artifact-smoke (24)",
  "container-smoke (linux/amd64)",
  "container-smoke (linux/arm64)",
  "server-json",
];

// ci.yml's source, or null when the swept directory has none.
function ciSource(dir: string) {
  return workflowFiles(dir).includes(CI) ? readFileSync(join(dir, CI), "utf8") : null;
}

function checkNameViolations(dir: string) {
  const source = ciSource(dir);
  if (source === null) return [`there is no ${CI}`];
  const violations: string[] = [];
  if (!/^name: ci$/m.test(source)) violations.push(`${CI} is no longer named "ci"`);

  const names: string[] = [];
  for (const job of jobBlocks(source)) {
    for (const key of ["name", "if"]) {
      if (new RegExp(`^ {4}["']?${key}["']?[ \\t]*:`, "m").test(job.body)) {
        violations.push(`${CI} job "${job.name}" sets ${key}:, which renames or skips its check`);
      }
    }
    const matrix = blockEntries(childBlock(job.body, "matrix", 6));
    if (matrix === null) {
      names.push(job.name);
      continue;
    }
    const axis = matrix.length === 1 ? matrix[0].match(/^[\w-]+:\s*\[(.*)\]$/) : null;
    if (!axis) {
      violations.push(`${CI} job "${job.name}" has a matrix that is not one inline list, so its check names are not pinned here`);
      continue;
    }
    for (const value of axis[1].split(",")) names.push(`${job.name} (${value.trim()})`);
  }
  if (names.join("\n") !== CHECK_NAMES.join("\n")) {
    violations.push(`${CI}'s checks are [${names.join(", ")}] rather than [${CHECK_NAMES.join(", ")}]`);
  }
  return violations;
}

// Each secret read in `text`: a named secret, the whole secrets context, the
// job token, or a `secrets:` key, which hands a called workflow secrets
// without any expression. Contexts are read only inside an expression -- a
// `${{ }}`, or the bare form an if: takes -- and are case-insensitive there,
// so every expression is searched for the secrets context in any spelling
// (dot, bracket, toJSON(secrets)) and for github.token or github['token'],
// which is the same value as secrets.GITHUB_TOKEN. A `${{ }}` may span lines,
// and a bare if: runs on over the lines indented deeper than its key, as a
// block scalar or a wrapped plain scalar does. A whole-line comment is not
// code.
function secretReads(text: string) {
  const lines = text.split("\n").filter((entry) => !/^\s*#/.test(entry));
  const expressions = [...lines.join("\n").matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(([, expression]) => expression);
  const reads: SecretRead[] = [];
  lines.forEach((line, at) => {
    if (/^\s*-?\s*["']?secrets["']?\s*:/.test(line)) reads.push({ label: "hands secrets: to a called workflow" });
    const bareIf = line.match(/^(\s*-?\s*)if:\s*(?!\$\{\{)(.*)$/);
    if (!bareIf) return;
    const value = [bareIf[2]];
    for (let next = at + 1; next < lines.length; next += 1) {
      if (lines[next].trim() !== "" && lines[next]!.match(/^ */)![0].length <= bareIf[1].length) break;
      value.push(lines[next]);
    }
    expressions.push(value.join("\n"));
  });
  for (const expression of expressions) {
    for (const [, member] of expression.matchAll(/\bsecrets\b(?:\s*\.\s*([A-Za-z0-9_]+))?/gi)) {
      reads.push(member ? { label: `reads the secret ${member}`, secret: member } : { label: "reads the secrets context" });
    }
    if (/\bgithub\s*(\.\s*token\b|\[\s*["']token["']\s*\])/i.test(expression)) {
      reads.push({ label: "reads the job token", secret: "GITHUB_TOKEN" });
    }
  }
  return reads;
}

// ci.yml runs on a fork's pull request, which gets no repository secrets, and
// it publishes nothing, so it has no use for one. The job token counts too,
// as secrets.GITHUB_TOKEN or github.token: nothing in ci.yml needs more than
// the checkout's read.
function secretViolations(dir: string) {
  const source = ciSource(dir);
  if (source === null) return [];
  return secretReads(source).map(({ label }) => `${CI} ${label}`);
}

// The secrets release.yml may read, as (job, secret), in the shape of the
// write-scope allowlist: a read with no row fails, and so does a row its job
// no longer reads. The image jobs log in to GHCR with the job token, which
// packages: write scopes to this repository's packages; npm and the registry
// log in through OIDC and need none. A read outside a job, of the whole
// secrets context, or through a `secrets:` key can take no row.
const SECRET_ALLOWLIST: SecretRow[] = [
  ["image-build", "GITHUB_TOKEN"],
  ["image", "GITHUB_TOKEN"],
];

const readKey = (job: string, secret: string) => `${job} › ${secret}`;

// Everything in a workflow but its jobs: block, which is where a top-level
// env:, defaults: or any key after jobs: sits.
function outsideJobs(source: string) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => /^jobs:/.test(line));
  if (at === -1) return source;
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^[\s#]/.test(lines[end]))) end += 1;
  return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

function releaseSecretViolations(dir: string, allowlist: SecretRow[] = SECRET_ALLOWLIST) {
  if (!workflowFiles(dir).includes(RELEASE)) return [`there is no ${RELEASE}`];
  const source = readFileSync(join(dir, RELEASE), "utf8");
  const allowed = new Set(allowlist.map((row) => readKey(...row)));
  const violations = secretReads(outsideJobs(source)).map(({ label }) => `${RELEASE} ${label} outside a job`);
  const read = new Set<string>();
  for (const job of jobBlocks(source)) {
    for (const { label, secret } of secretReads(job.body)) {
      if (secret === undefined) {
        violations.push(`${RELEASE} job "${job.name}" ${label}`);
        continue;
      }
      read.add(readKey(job.name, secret));
      if (!allowed.has(readKey(job.name, secret))) {
        violations.push(`${RELEASE} job "${job.name}" ${label}, which is not on the secret allowlist`);
      }
    }
  }
  for (const [job, secret] of allowlist) {
    if (!read.has(readKey(job, secret))) {
      violations.push(`${RELEASE} job "${job}" does not read ${secret}, so its secret allowlist row is stale`);
    }
  }
  return violations;
}

// A prerelease is not yet a version for everyone, so nothing
// that reaches everyone who does not ask for a version may carry one: npm's
// latest dist-tag, the image's :latest tag and the MCP registry entry. Each
// step or job that names :latest, and the registry job, must carry exactly
// this guard; a looser condition, or :latest added to an unguarded step, is a
// prerelease shipped as the default. npm publishes under the one expression
// that picks next for a prerelease. Whole-line comments are not code. The
// sweep reads the literal text, so a tool that spells the tag some other way
// is for review to catch.
const RELEASE = "release.yml";
const PRERELEASE_GUARD = "if: ${{ !github.event.release.prerelease }}";

// A job's lines split into its steps, each starting at a `- ` six spaces in,
// and whatever sits outside them (runs-on, env, permissions).
function jobSegments(jobBody: string) {
  const outside: string[] = [];
  const steps: string[][] = [];
  let step: string[] | null = null;
  for (const line of jobBody.split("\n")) {
    if (/^ {6}- /.test(line)) {
      step = [line];
      steps.push(step);
    } else if (step && (line.trim() === "" || line.trim().startsWith("#") || /^ {7,}/.test(line))) {
      step.push(line);
    } else {
      step = null;
      outside.push(line);
    }
  }
  return { outside, steps };
}

// A step's lines with its leading `- ` turned into indent, so the first key
// reads like every other key in the step.
const stepLines = (lines: string[]) => lines.map((line) => line.replace(/^( *)- /, "$1  "));
const carriesGuard = (lines: string[], indent: number) => stepLines(lines).includes(`${" ".repeat(indent)}${PRERELEASE_GUARD}`);
const namesLatest = (lines: string[]) => lines.some((line) => !/^\s*#/.test(line) && line.includes(":latest"));
const NPM_DIST_TAG = "          DIST_TAG: ${{ github.event.release.prerelease && 'next' || 'latest' }}";
const NPM_PUBLISH = '        run: npm publish --tag "$DIST_TAG"';

function prereleaseViolations(dir: string) {
  if (!workflowFiles(dir).includes(RELEASE)) return [`there is no ${RELEASE}`];
  const source = readFileSync(join(dir, RELEASE), "utf8");
  const violations: string[] = [];
  const jobs = jobBlocks(source);
  let appliesLatest = false;
  const beforeJobs = source.slice(0, source.indexOf("\njobs:"));
  if (namesLatest(beforeJobs.split("\n"))) violations.push(`${RELEASE} names :latest outside a job`);

  for (const job of jobs) {
    const { outside, steps } = jobSegments(job.body);
    const jobGuarded = carriesGuard(outside, 4);
    if (job.name === "registry" && !jobGuarded) violations.push(`${RELEASE} job "registry" is not skipped on a prerelease`);
    const lines = job.body.split("\n");
    if (job.name === "npm" && !(lines.includes(NPM_DIST_TAG) && lines.includes(NPM_PUBLISH))) {
      violations.push(`${RELEASE} job "npm" does not publish a prerelease under next`);
    }
    // The guarded path must still do something: a run: line that names it.
    if (steps.some((step) => carriesGuard(step, 8) && step.some((line) => /^ {8}run: .*:latest/.test(line)))) appliesLatest = true;
    if (jobGuarded) continue;
    if (namesLatest(outside) || steps.some((step) => namesLatest(step) && !carriesGuard(step, 8))) {
      violations.push(`${RELEASE} job "${job.name}" can apply :latest on a prerelease`);
    }
  }
  if (!jobs.some((job) => job.name === "registry")) violations.push(`${RELEASE} has no registry job`);
  if (!appliesLatest) violations.push(`${RELEASE} has no guarded step that applies :latest`);
  return violations;
}

// Each platform image carries metadata-action's OCI labels, so `docker inspect`
// on a running container names the commit and version it was built from. The
// semver rule is the only source of org.opencontainers.image.version: with no
// tag rule matching, metadata-action leaves the version label empty.
const META_ID = "        id: meta";
const META_VERSION = "          tags: type=semver,pattern={{version}}";
const BUILD_LABELS = "          labels: ${{ steps.meta.outputs.labels }}";
const META_STEP =
  "      - id: meta\n        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0\n        with:\n          images: ${{ env.IMAGE }}\n          tags: type=semver,pattern={{version}}\n";

function labelViolations(dir: string) {
  if (!workflowFiles(dir).includes(RELEASE)) return [`there is no ${RELEASE}`];
  const job = jobBlocks(readFileSync(join(dir, RELEASE), "utf8")).find(({ name }) => name === "image-build");
  if (!job) return [`${RELEASE} has no image-build job`];
  const { steps } = jobSegments(job.body);
  const usesAction = (step: string[], action: string) => stepLines(step).some((line) => line.startsWith(`        uses: ${action}@`));
  const violations: string[] = [];
  const metaAt = steps.findIndex((step) => usesAction(step, "docker/metadata-action"));
  if (metaAt === -1) {
    violations.push(`${RELEASE} job "image-build" has no docker/metadata-action step`);
  } else {
    const lines = stepLines(steps[metaAt]);
    if (!lines.includes(META_ID)) violations.push(`${RELEASE} job "image-build"'s metadata-action step is not id: meta`);
    if (!lines.includes(META_VERSION)) violations.push(`${RELEASE} job "image-build" gives the image no version label`);
  }
  const builds = steps.flatMap((step, at) => (usesAction(step, "docker/build-push-action") ? [{ step, at }] : []));
  if (builds.length === 0) violations.push(`${RELEASE} job "image-build" has no docker/build-push-action step`);
  if (builds.some(({ step }) => !step.includes(BUILD_LABELS))) {
    violations.push(`${RELEASE} job "image-build" builds an image without metadata-action's OCI labels`);
  }
  // A step's outputs are empty to the steps before it, so a build above the
  // metadata step would read no labels and still succeed.
  if (metaAt !== -1 && builds.some(({ at }) => at < metaAt)) {
    violations.push(`${RELEASE} job "image-build" builds before metadata-action computes the labels`);
  }
  return violations;
}

// The registry validates server.json against both packages, and mcp-publisher
// never retries a refusal. So the registry job waits for the image job as well
// as npm, and runs its anonymous pull check in a step before the publish: a
// private GHCR package then fails with a step that says how to fix it, rather
// than with the registry's rejection. The check stays anonymous, as the
// registry is, so the job logs in to no container registry. The sweep reads
// text order only; what the pull step does with a refusal is for review.
const PUBLIC_PULL = "docker buildx imagetools inspect";
const PUBLISH = '"$RUNNER_TEMP/mcp-publisher" publish';

function registryViolations(dir: string) {
  if (!workflowFiles(dir).includes(RELEASE)) return [`there is no ${RELEASE}`];
  const job = jobBlocks(readFileSync(join(dir, RELEASE), "utf8")).find(({ name }) => name === "registry");
  if (!job) return [`${RELEASE} has no registry job`];
  const violations: string[] = [];
  const needs = (blockEntries(childBlock(job.body, "needs", 4)) ?? [])
    .flatMap((entry) => withoutComment(entry).replace(/^\[|\]$/g, "").split(","))
    .map((entry) => entry.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, ""));
  for (const upstream of ["npm", "image"]) {
    if (!needs.includes(upstream)) violations.push(`${RELEASE} job "registry" does not need "${upstream}"`);
  }
  const { steps } = jobSegments(job.body);
  const code = (step: string[]) => step.map(withoutComment).join("\n");
  const pullAt = steps.findIndex((step) => code(step).includes(PUBLIC_PULL));
  const publishAt = steps.findIndex((step) => code(step).includes(PUBLISH));
  if (pullAt === -1) violations.push(`${RELEASE} job "registry" never checks the image is publicly pullable`);
  if (publishAt === -1) violations.push(`${RELEASE} job "registry" never runs mcp-publisher publish`);
  if (pullAt !== -1 && publishAt !== -1 && pullAt > publishAt) {
    violations.push(`${RELEASE} job "registry" publishes before checking the image is publicly pullable`);
  }
  if (steps.some((step) => /docker\/login-action@|docker login/.test(code(step)))) {
    violations.push(`${RELEASE} job "registry" logs in to a container registry, which the anonymous pull check rules out`);
  }
  return violations;
}

// ci.yml's server-json job asks the registry to validate server.json with the
// same mcp-publisher release.yml publishes with: one version's verdict says
// little about another's. So the job runs validate in a step that can neither
// be skipped nor have its failure ignored, and its download URL and SHA-256
// are release.yml's registry job's, character for character.
const VALIDATE = '"$RUNNER_TEMP/mcp-publisher" validate server.json';

// The mcp-publisher download a job's env names, as its URL and SHA-256 values.
function publisherPin(body: string): Record<"url" | "sha256", string | null> {
  const value = (key: string) => body.match(new RegExp(`^ +${key}: (\\S+)\\s*$`, "m"))?.[1] ?? null;
  const url = value("URL");
  return { url: url?.includes("/mcp-publisher_") ? url : null, sha256: value("SHA256") };
}

function serverJsonViolations(dir: string) {
  const source = ciSource(dir);
  if (source === null) return [`there is no ${CI}`];
  if (!workflowFiles(dir).includes(RELEASE)) return [`there is no ${RELEASE}`];
  const job = jobBlocks(source).find(({ name }) => name === "server-json");
  if (!job) return [`${CI} has no server-json job`];
  const registry = jobBlocks(readFileSync(join(dir, RELEASE), "utf8")).find(({ name }) => name === "registry");
  if (!registry) return [`${RELEASE} has no registry job`];

  const violations: string[] = [];
  const code = (step: string[]) => step.map(withoutComment).join("\n");
  const validate = jobSegments(job.body).steps.find((step) => code(step).includes(VALIDATE));
  if (!validate) violations.push(`${CI} job "server-json" never runs mcp-publisher validate server.json`);
  else if (/^\s*(?:-\s+)?(?:if|continue-on-error)\s*:/m.test(code(validate))) {
    violations.push(`${CI} job "server-json" lets its validate step be skipped or fail without failing the job`);
  }
  const ci = publisherPin(job.body);
  const release = publisherPin(registry.body);
  for (const key of ["url", "sha256"] as const) {
    if (release[key] === null) violations.push(`${RELEASE} job "registry" names no mcp-publisher ${key}`);
    else if (ci[key] === null) violations.push(`${CI} job "server-json" names no mcp-publisher ${key}`);
    else if (ci[key] !== release[key]) {
      violations.push(`${CI} job "server-json" downloads mcp-publisher by ${key} ${ci[key]}, not ${RELEASE}'s ${release[key]}`);
    }
  }
  return violations;
}

test("every uses: is pinned to a full commit SHA with a version comment", () => {
  assert.deepEqual(pinViolations(workflowsDir), []);
});

test("every job declares timeout-minutes and runs-on", () => {
  assert.deepEqual(jobKeyViolations(workflowsDir), []);
});

test("no workflow triggers on pull_request_target or workflow_run", () => {
  assert.deepEqual(triggerViolations(workflowsDir), []);
});

test("every pull_request trigger is filtered to branches and cancels superseded runs", () => {
  assert.deepEqual(pullRequestViolations(workflowsDir), []);
});

test("every workflow's default token is declared and read-only", () => {
  assert.deepEqual(defaultPermissionViolations(workflowsDir), []);
});

test("write scopes are granted only where the allowlist names them", () => {
  assert.deepEqual(writeScopeViolations(workflowsDir), []);
});

test("ci.yml reports the pinned check names", () => {
  assert.deepEqual(checkNameViolations(workflowsDir), []);
});

test("ci.yml reads no secret", () => {
  assert.deepEqual(secretViolations(workflowsDir), []);
});

test("release.yml reads secrets only where the allowlist names them", () => {
  assert.deepEqual(releaseSecretViolations(workflowsDir), []);
});

test("release.yml applies :latest and lists the registry entry only off a prerelease", () => {
  assert.deepEqual(prereleaseViolations(workflowsDir), []);
});

test("release.yml builds each platform image with metadata-action's OCI labels and a version", () => {
  assert.deepEqual(labelViolations(workflowsDir), []);
});

test("release.yml publishes the registry entry only after an anonymous pull of the image", () => {
  assert.deepEqual(registryViolations(workflowsDir), []);
});

test("ci.yml validates server.json with the mcp-publisher release.yml publishes with", () => {
  assert.deepEqual(serverJsonViolations(workflowsDir), []);
});

// The anti-vacuity pin: a sweep that has stopped seeing any workflow, job or
// uses: line still reports success over everything it looked at, so what it
// found is pinned as well as what it did not.
test("sweeps the real, non-empty set of workflows, jobs and uses: lines", () => {
  assert.deepEqual(workflowFiles(workflowsDir), [CI, RELEASE]);

  const source = readFileSync(join(workflowsDir, CI), "utf8");
  assert.deepEqual(
    jobBlocks(source).map((job) => job.name),
    ["build", "artifact-smoke", "container-smoke", "server-json"],
  );
  assert.deepEqual(
    usesLines(source).map(({ value }) => value.split("@")[0]),
    [
      "actions/checkout",
      "actions/setup-node",
      "actions/checkout",
      "actions/setup-node",
      "actions/checkout",
      "actions/setup-node",
      "actions/checkout",
    ],
  );

  const release = readFileSync(join(workflowsDir, RELEASE), "utf8");
  assert.deepEqual(
    jobBlocks(release).map((job) => job.name),
    ["ci", "verify", "npm", "image-build", "image", "registry"],
  );
  assert.deepEqual(
    usesLines(release).map(({ value }) => value.split("@")[0]),
    [
      "./.github/workflows/ci.yml",
      "actions/checkout",
      "actions/setup-node",
      "actions/checkout",
      "actions/setup-node",
      "actions/checkout",
      "docker/setup-buildx-action",
      "docker/login-action",
      "docker/metadata-action",
      "docker/build-push-action",
      "actions/upload-artifact",
      "actions/download-artifact",
      "docker/setup-buildx-action",
      "docker/login-action",
      "actions/attest-build-provenance",
      "actions/checkout",
    ],
  );
});

// A throwaway directory of the given files, handed to a sweep and cleaned up
// after, so a mutation never writes over a tracked file.
function fixtureViolations(files: Record<string, string>, sweep: Sweep) {
  const dir = mkdtempSync(join(tmpdir(), "plex-mcp-workflow-contract-"));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    return sweep(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every real workflow, with the first `from` in `file` (ci.yml unless named)
// replaced, swept from a fixture directory. The other workflows are copied
// unchanged so the allowlist's rows for them still find their grants. The
// anchor must exist and the edit must change the file, so a stale case cannot
// pass by mutating nothing.
function mutatedViolations(from: string, to: string, sweep: Sweep, file = CI) {
  const files = Object.fromEntries([...eachWorkflow(workflowsDir)].map(({ name, source }) => [name, source]));
  const source = files[file];
  assert.ok(source.includes(from), `anchor not found in ${file}: ${from}`);
  const mutated = source.replace(from, () => to);
  assert.notEqual(mutated, source, `mutation left ${file} unchanged: ${from}`);
  return fixtureViolations({ ...files, [file]: mutated }, sweep);
}

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const BUILD_HEADER = "  build:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n";
const NPM_TEST = "      - run: npm test\n";
const DEFAULT_TOKEN = "permissions:\n  contents: read\n";
const ARTIFACT_MATRIX = "        node: [22, 24]\n";
const checkNames = (names: string[]) => `${CI}'s checks are [${names.join(", ")}] rather than [${CHECK_NAMES.join(", ")}]`;

// Each row is one weakening of the real ci.yml, the sweep that must catch it,
// and what that sweep must report. Every kept guarantee has at least one.
const MUTATIONS: Mutation[] = [
  // Pinned actions.
  ["a pin is reverted to a floating tag", CHECKOUT, "actions/checkout@v7", pinViolations, `${CI}: "actions/checkout@v7" is not pinned to a full commit SHA`],
  [
    "a pin loses its version comment",
    CHECKOUT,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    pinViolations,
    `${CI}: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" is SHA-pinned but has no trailing "# vX.Y.Z" comment naming the version`,
  ],
  [
    "a job calls another repository's workflow by tag",
    BUILD_HEADER,
    `  shared:\n    uses: some-owner/some-repo/.github/workflows/x.yml@v1\n${BUILD_HEADER}`,
    pinViolations,
    `${CI}: "some-owner/some-repo/.github/workflows/x.yml@v1" is not pinned to a full commit SHA`,
  ],

  // timeout-minutes and runs-on.
  ["a job loses its timeout-minutes", BUILD_HEADER, "  build:\n    runs-on: ubuntu-24.04\n", jobKeyViolations, `${CI} job "build" declares no timeout-minutes`],
  ["a job loses its runs-on", BUILD_HEADER, "  build:\n    timeout-minutes: 15\n", jobKeyViolations, `${CI} job "build" declares no runs-on`],
  ["a job's timeout-minutes is left empty", "    timeout-minutes: 15\n", "    timeout-minutes:\n", jobKeyViolations, `${CI} job "build" declares no timeout-minutes`],

  // Fork-exposed triggers.
  [
    "the pull_request trigger becomes pull_request_target",
    "  pull_request:\n",
    "  pull_request_target:\n",
    triggerViolations,
    `${CI} triggers on pull_request_target, which runs fork-initiated work with base-repository access`,
  ],
  [
    "a workflow_run trigger is added",
    "  workflow_dispatch:\n",
    "  workflow_dispatch:\n  workflow_run:\n    workflows: [other]\n",
    triggerViolations,
    `${CI} triggers on workflow_run, which runs fork-initiated work with base-repository access`,
  ],

  // The pull_request filter and its cancellation.
  [
    "the pull_request trigger loses its branches: filter",
    "  pull_request:\n    branches: [main]\n",
    "  pull_request:\n",
    pullRequestViolations,
    `${CI} triggers on pull_request with no branches: filter`,
  ],
  [
    "the concurrency block loses cancel-in-progress",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    "",
    pullRequestViolations,
    `${CI} triggers on pull_request but never cancels a superseded run`,
  ],
  [
    "the concurrency block never cancels",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    "  cancel-in-progress: false\n",
    pullRequestViolations,
    `${CI} triggers on pull_request but never cancels a superseded run`,
  ],
  [
    "pull_request is listed as a sequence item under on:",
    "  pull_request:\n    branches: [main]\n",
    "  - pull_request\n",
    pullRequestViolations,
    `${CI} triggers on pull_request with no branches: filter`,
  ],
  [
    "the concurrency block never cancels, behind a comment and quotes",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    "  cancel-in-progress: 'false' # for now\n",
    pullRequestViolations,
    `${CI} triggers on pull_request but never cancels a superseded run`,
  ],
  [
    "the triggers collapse to the inline form",
    "on:\n  pull_request:\n    branches: [main]\n",
    "on: [pull_request]\nx:\n",
    pullRequestViolations,
    `${CI} triggers on pull_request with no branches: filter`,
  ],

  // The read-only default token.
  [
    "the workflow-level token is removed",
    `${DEFAULT_TOKEN}\n`,
    "",
    defaultPermissionViolations,
    `${CI} declares no workflow-level permissions:, so its default token is the repository's`,
  ],
  ["the workflow-level token becomes a write", DEFAULT_TOKEN, "permissions:\n  contents: write\n", defaultPermissionViolations, `${CI} grants contents: write at workflow level, where only read is allowed`],
  ["the workflow-level token becomes write-all", DEFAULT_TOKEN, "permissions: write-all\n", defaultPermissionViolations, `${CI} grants write-all at workflow level, where only read is allowed`],

  // The write-scope allowlist, in each shape YAML allows a grant.
  [
    "a job is granted a write scope",
    BUILD_HEADER,
    `${BUILD_HEADER}    permissions:\n      contents: write\n`,
    writeScopeViolations,
    `${CI} job "build" grants contents: write, which is not on the write-scope allowlist`,
  ],
  [
    "a job is granted a quoted write scope",
    BUILD_HEADER,
    `${BUILD_HEADER}    permissions:\n      "id-token": 'write' # for OIDC\n`,
    writeScopeViolations,
    `${CI} job "build" grants id-token: write, which is not on the write-scope allowlist`,
  ],
  [
    "a job is granted write-all",
    BUILD_HEADER,
    `${BUILD_HEADER}    permissions: write-all\n`,
    writeScopeViolations,
    `${CI} job "build" grants write-all, which is not on the write-scope allowlist`,
  ],
  [
    "a job is granted a write scope in a wrapped flow mapping",
    BUILD_HEADER,
    `${BUILD_HEADER}    permissions: { contents: read,\n      packages: write } # the push\n`,
    writeScopeViolations,
    `${CI} job "build" grants packages: write, which is not on the write-scope allowlist`,
  ],
  [
    "a job is granted a write scope under a comment at the key's indent",
    BUILD_HEADER,
    `${BUILD_HEADER}    permissions:\n    # for the release notes\n      contents: write\n`,
    writeScopeViolations,
    `${CI} job "build" grants contents: write, which is not on the write-scope allowlist`,
  ],
  [
    "a job whose key carries a comment is granted a write scope",
    BUILD_HEADER,
    `  deploy: # extra\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: write\n${BUILD_HEADER}`,
    writeScopeViolations,
    `${CI} job "deploy" grants contents: write, which is not on the write-scope allowlist`,
  ],

  [
    "a job with a quoted key is granted a write scope",
    BUILD_HEADER,
    `  "deploy":\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      contents: write\n${BUILD_HEADER}`,
    writeScopeViolations,
    `${CI} job "deploy" grants contents: write, which is not on the write-scope allowlist`,
  ],

  // Pinned check names.
  ["the workflow is renamed", "name: ci\n", "name: checks\n", checkNameViolations, `${CI} is no longer named "ci"`],
  [
    "the build job key changes",
    "  build:\n",
    "  test:\n",
    checkNameViolations,
    checkNames(["test", ...CHECK_NAMES.slice(1)]),
  ],
  [
    "the build check is renamed",
    BUILD_HEADER,
    `${BUILD_HEADER}    name: tests\n`,
    checkNameViolations,
    `${CI} job "build" sets name:, which renames or skips its check`,
  ],
  [
    "the build check can be skipped",
    BUILD_HEADER,
    `${BUILD_HEADER}    if: github.event_name == 'push'\n`,
    checkNameViolations,
    `${CI} job "build" sets if:, which renames or skips its check`,
  ],
  [
    "a Node version leaves the artifact-smoke matrix",
    ARTIFACT_MATRIX,
    "        node: [22]\n",
    checkNameViolations,
    checkNames(CHECK_NAMES.filter((name) => name !== "artifact-smoke (24)")),
  ],
  [
    "the arm64 leg leaves the container-smoke matrix",
    "        platform: [linux/amd64, linux/arm64]\n",
    "        platform: [linux/amd64]\n",
    checkNameViolations,
    checkNames(CHECK_NAMES.filter((name) => name !== "container-smoke (linux/arm64)")),
  ],
  [
    "a matrix grows a second axis",
    ARTIFACT_MATRIX,
    `${ARTIFACT_MATRIX}        os: [ubuntu-24.04]\n`,
    checkNameViolations,
    [
      `${CI} job "artifact-smoke" has a matrix that is not one inline list, so its check names are not pinned here`,
      checkNames(CHECK_NAMES.filter((name) => !name.startsWith("artifact-smoke"))),
    ],
  ],

  // No secrets.
  [
    "a step reads a repository secret",
    NPM_TEST,
    `${NPM_TEST}        env:\n          TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
    secretViolations,
    `${CI} reads the secret NPM_TOKEN`,
  ],
  [
    "a step reads the job token",
    NPM_TEST,
    `${NPM_TEST}        env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`,
    secretViolations,
    `${CI} reads the secret GITHUB_TOKEN`,
  ],
  [
    "a step reads the job token through the github context",
    NPM_TEST,
    `${NPM_TEST}        env:\n          GH_TOKEN: \${{ github.token }}\n`,
    secretViolations,
    `${CI} reads the job token`,
  ],
  [
    "a step reads the job token in another case and by bracket",
    NPM_TEST,
    `${NPM_TEST}        env:\n          A: \${{ GITHUB.TOKEN }}\n          B: \${{ github['token'] }}\n`,
    secretViolations,
    [`${CI} reads the job token`, `${CI} reads the job token`],
  ],
  [
    "a step reads a secret in another case",
    NPM_TEST,
    `${NPM_TEST}        env:\n          T: \${{ Secrets.NPM_TOKEN }}\n`,
    secretViolations,
    `${CI} reads the secret NPM_TOKEN`,
  ],
  [
    "a secret is read after a quoted #",
    NPM_TEST,
    `${NPM_TEST}      - run: echo "a #b" && curl \${{ secrets.T }}\n`,
    secretViolations,
    `${CI} reads the secret T`,
  ],
  [
    "a step reads a secret by bracket access",
    NPM_TEST,
    `${NPM_TEST}        env:\n          T: \${{ secrets['NPM_TOKEN'] }}\n`,
    secretViolations,
    `${CI} reads the secrets context`,
  ],
  [
    "a step dumps every secret",
    NPM_TEST,
    `${NPM_TEST}        env:\n          ALL: \${{ toJSON(secrets) }}\n`,
    secretViolations,
    `${CI} reads the secrets context`,
  ],
  [
    "a called workflow is handed every secret",
    BUILD_HEADER,
    `  shared:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n${BUILD_HEADER}`,
    secretViolations,
    `${CI} hands secrets: to a called workflow`,
  ],
  // server.json validated with release.yml's mcp-publisher.
  [
    "the server-json job pins another mcp-publisher digest",
    "          SHA256: a06c9096",
    "          SHA256: b06c9096",
    serverJsonViolations,
    `${CI} job "server-json" downloads mcp-publisher by sha256 b06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc, not ${RELEASE}'s a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc`,
  ],
  [
    "the server-json job downloads another mcp-publisher version",
    "/download/v1.8.1/mcp-publisher_linux_amd64",
    "/download/v1.8.0/mcp-publisher_linux_amd64",
    serverJsonViolations,
    `${CI} job "server-json" downloads mcp-publisher by url https://github.com/modelcontextprotocol/registry/releases/download/v1.8.0/mcp-publisher_linux_amd64.tar.gz, not ${RELEASE}'s https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_linux_amd64.tar.gz`,
  ],
  [
    "the server-json job stops running validate",
    `      - run: '${VALIDATE}'\n`,
    `      # - run: '${VALIDATE}'\n`,
    serverJsonViolations,
    `${CI} job "server-json" never runs mcp-publisher validate server.json`,
  ],
  [
    "the server-json job loses its download URL",
    "          URL: https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/",
    "          SOURCE: https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/",
    serverJsonViolations,
    `${CI} job "server-json" names no mcp-publisher url`,
  ],
  [
    "the server-json job's validate step may fail",
    `      - run: '${VALIDATE}'\n`,
    `      - run: '${VALIDATE}'\n        continue-on-error: true\n`,
    serverJsonViolations,
    `${CI} job "server-json" lets its validate step be skipped or fail without failing the job`,
  ],
  [
    "the server-json job's validate step is skipped",
    `      - run: '${VALIDATE}'\n`,
    `      - if: false\n        run: '${VALIDATE}'\n`,
    serverJsonViolations,
    `${CI} job "server-json" lets its validate step be skipped or fail without failing the job`,
  ],
  [
    "the server-json job is removed",
    "  server-json:\n",
    "  validate-later:\n",
    serverJsonViolations,
    `${CI} has no server-json job`,
  ],
];

const LATEST_STEP = "      - name: Move :latest to this release\n        if: ${{ !github.event.release.prerelease }}\n";
const MERGE_TAG = '--tag "$IMAGE:$TAG" "${sources[@]}"';
const REGISTRY_NEEDS = "  registry:\n    needs: [npm, image]\n";
const REGISTRY_GUARD = `${REGISTRY_NEEDS}    if: \${{ !github.event.release.prerelease }}\n`;
const NPM_GRANT = "  npm:\n    needs: verify\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read\n";
// The public-pull step as it stands in the real release.yml, from its name to
// the next step or the end of the file, so a mutation can remove or move it
// whole. Empty when the step is gone, which fails each mutation that uses it.
const PULL_STEP = (() => {
  const source = readFileSync(join(workflowsDir, RELEASE), "utf8");
  const start = source.indexOf("      - name: Check the image is publicly pullable\n");
  if (start === -1) return "";
  const next = source.indexOf("\n      - ", start + 1);
  return source.slice(start, next === -1 ? source.length : next + 1);
})();
const REGISTRY_GRANT = `${REGISTRY_GUARD}    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read\n`;
const REGISTRY_ID_TOKEN = `${REGISTRY_GRANT}      id-token: write\n`;
const VERIFY_HEADER = "  verify:\n    needs: ci\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n";
const WORKFLOW_ENV = "env:\n  IMAGE: ghcr.io/dustinhansen/plex-mcp\n";
const CI_CALL = "  ci:\n    uses: ./.github/workflows/ci.yml\n";
// The npm publish step's env line that holds no secret.
const NPM_ENV = `${NPM_DIST_TAG}\n`;
// The first GHCR login in release.yml, which is image-build's.
const GHCR_PASSWORD = "          password: ${{ secrets.GITHUB_TOKEN }}\n";

// The same, for release.yml.
const RELEASE_MUTATIONS: Mutation[] = [
  // The write-scope allowlist, both ways round.
  [
    "the npm job is granted an extra write scope",
    NPM_GRANT,
    NPM_GRANT.replace("      contents: read\n", "      contents: write\n"),
    writeScopeViolations,
    `${RELEASE} job "npm" grants contents: write, which is not on the write-scope allowlist`,
  ],
  [
    "the registry job loses the grant its row names",
    `${REGISTRY_GRANT}      id-token: write\n`,
    REGISTRY_GRANT,
    writeScopeViolations,
    `${RELEASE} job "registry" does not grant id-token: write, so its write-scope allowlist row is stale`,
  ],

  // The secret allowlist, both ways round.
  [
    "the verify job reads a new secret",
    VERIFY_HEADER,
    `${VERIFY_HEADER}    env:\n      EXTRA: \${{ secrets.EXTRA_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "verify" reads the secret EXTRA_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "the npm job reads a new secret",
    NPM_ENV,
    `${NPM_ENV}          EXTRA: \${{ secrets.EXTRA_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "npm" reads the secret EXTRA_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "the npm job reads an npm token",
    NPM_ENV,
    `${NPM_ENV}          NODE_AUTH_TOKEN: \${{ secrets.NODE_AUTH_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "npm" reads the secret NODE_AUTH_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "a secret is read in the workflow-level env",
    WORKFLOW_ENV,
    `${WORKFLOW_ENV}  EXTRA: \${{ secrets.EXTRA_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} reads the secret EXTRA_TOKEN outside a job`,
  ],
  [
    "the image-build job reads the npm token",
    GHCR_PASSWORD,
    `${GHCR_PASSWORD}          extra: \${{ secrets.NODE_AUTH_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "image-build" reads the secret NODE_AUTH_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "the registry job reads the job token as a secret",
    REGISTRY_ID_TOKEN,
    `${REGISTRY_ID_TOKEN}    env:\n      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "registry" reads the secret GITHUB_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "the registry job reads the job token through the github context",
    REGISTRY_ID_TOKEN,
    `${REGISTRY_ID_TOKEN}    env:\n      GH_TOKEN: \${{ github.token }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "registry" reads the job token, which is not on the secret allowlist`,
  ],
  [
    "a job dumps every secret",
    NPM_ENV,
    `${NPM_ENV}          ALL: \${{ toJSON(secrets) }}\n`,
    releaseSecretViolations,
    `${RELEASE} job "npm" reads the secrets context`,
  ],
  [
    "the called ci workflow is handed every secret",
    CI_CALL,
    `${CI_CALL}    secrets: inherit\n`,
    releaseSecretViolations,
    `${RELEASE} job "ci" hands secrets: to a called workflow`,
  ],
  [
    "a job reads a secret in an expression split across lines",
    NPM_ENV,
    `${NPM_ENV}          EXTRA: "\${{\n            secrets.EXTRA_TOKEN }}"\n`,
    releaseSecretViolations,
    `${RELEASE} job "npm" reads the secret EXTRA_TOKEN, which is not on the secret allowlist`,
  ],
  [
    "a job reads a secret in a bare if: block scalar",
    VERIFY_HEADER,
    `${VERIFY_HEADER}    if: >-\n      secrets.EXTRA_TOKEN != ''\n`,
    releaseSecretViolations,
    `${RELEASE} job "verify" reads the secret EXTRA_TOKEN, which is not on the secret allowlist`,
  ],

  // :latest and the registry entry stay off a prerelease.
  [
    "the :latest step loses its guard",
    LATEST_STEP,
    "      - name: Move :latest to this release\n",
    prereleaseViolations,
    [`${RELEASE} job "image" can apply :latest on a prerelease`, `${RELEASE} has no guarded step that applies :latest`],
  ],
  [
    "the :latest step's guard is loosened",
    LATEST_STEP,
    "      - name: Move :latest to this release\n        if: ${{ always() }}\n",
    prereleaseViolations,
    [`${RELEASE} job "image" can apply :latest on a prerelease`, `${RELEASE} has no guarded step that applies :latest`],
  ],
  [
    "the merge step tags :latest as well",
    MERGE_TAG,
    '--tag "$IMAGE:$TAG" --tag "$IMAGE:latest" "${sources[@]}"',
    prereleaseViolations,
    `${RELEASE} job "image" can apply :latest on a prerelease`,
  ],
  [
    "the :latest step keeps its name but loses its command",
    'run: docker buildx imagetools create --tag "$IMAGE:latest" "$IMAGE:$TAG"',
    "run: echo skipped",
    prereleaseViolations,
    `${RELEASE} has no guarded step that applies :latest`,
  ],
  [
    "npm publishes a prerelease under latest",
    "${{ github.event.release.prerelease && 'next' || 'latest' }}",
    "latest",
    prereleaseViolations,
    `${RELEASE} job "npm" does not publish a prerelease under next`,
  ],
  [
    "npm publishes without the chosen dist-tag",
    'npm publish --tag "$DIST_TAG"',
    "npm publish",
    prereleaseViolations,
    `${RELEASE} job "npm" does not publish a prerelease under next`,
  ],
  // Each platform image keeps its OCI labels.
  [
    "the image build drops the labels input",
    `${BUILD_LABELS}\n`,
    "",
    labelViolations,
    `${RELEASE} job "image-build" builds an image without metadata-action's OCI labels`,
  ],
  [
    "the metadata-action step is removed",
    META_STEP,
    "",
    labelViolations,
    `${RELEASE} job "image-build" has no docker/metadata-action step`,
  ],
  [
    "the image build moves above the metadata-action step",
    META_STEP,
    "",
    (dir) => {
      const path = join(dir, RELEASE);
      const source = readFileSync(path, "utf8");
      const upload = "      - uses: actions/upload-artifact@";
      writeFileSync(path, source.replace(upload, () => `${META_STEP}${upload}`));
      return labelViolations(dir);
    },
    `${RELEASE} job "image-build" builds before metadata-action computes the labels`,
  ],
  [
    "the metadata-action step loses the id the build reads",
    `      - id: meta\n        uses: docker/metadata-action@`,
    `      - id: metadata\n        uses: docker/metadata-action@`,
    labelViolations,
    `${RELEASE} job "image-build"'s metadata-action step is not id: meta`,
  ],
  [
    "the version label loses its semver rule",
    META_VERSION,
    "          tags: type=sha",
    labelViolations,
    `${RELEASE} job "image-build" gives the image no version label`,
  ],
  [
    "the registry job loses its guard",
    REGISTRY_GUARD,
    REGISTRY_NEEDS,
    prereleaseViolations,
    `${RELEASE} job "registry" is not skipped on a prerelease`,
  ],

  // The registry entry waits for an anonymously pullable image.
  [
    "the registry job stops waiting for the image",
    REGISTRY_NEEDS,
    "  registry:\n    needs: npm\n",
    registryViolations,
    `${RELEASE} job "registry" does not need "image"`,
  ],
  [
    "the registry job's needs drop image from a block list",
    REGISTRY_NEEDS,
    "  registry:\n    needs:\n      - npm\n      - verify # image is slow\n",
    registryViolations,
    `${RELEASE} job "registry" does not need "image"`,
  ],
  [
    "the public-pull step moves after the publish step",
    PULL_STEP,
    "",
    (dir) => {
      // Appending puts the step after every other step of the last job, which
      // must be the registry job for this to move the step past the publish.
      const path = join(dir, RELEASE);
      assert.equal(jobBlocks(readFileSync(path, "utf8")).at(-1)!.name, "registry");
      writeFileSync(path, `${readFileSync(path, "utf8")}${PULL_STEP}`);
      return registryViolations(dir);
    },
    `${RELEASE} job "registry" publishes before checking the image is publicly pullable`,
  ],
  [
    "the public-pull step is removed",
    PULL_STEP,
    "",
    registryViolations,
    `${RELEASE} job "registry" never checks the image is publicly pullable`,
  ],
  [
    "the registry job stops naming the mcp-publisher digest",
    "          SHA256: a06c9096",
    "          DIGEST: a06c9096",
    serverJsonViolations,
    `${RELEASE} job "registry" names no mcp-publisher sha256`,
  ],
  [
    "the registry job logs in before its pull check",
    PULL_STEP,
    `      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n        with:\n          registry: ghcr.io\n${PULL_STEP}`,
    registryViolations,
    `${RELEASE} job "registry" logs in to a container registry, which the anonymous pull check rules out`,
  ],
];

for (const [name, from, to, sweep, expected] of MUTATIONS) {
  test(`fails when ${name}`, () => {
    assert.deepEqual(mutatedViolations(from, to, sweep), [expected].flat());
  });
}

for (const [name, from, to, sweep, expected] of RELEASE_MUTATIONS) {
  test(`fails when ${name}`, () => {
    assert.deepEqual(mutatedViolations(from, to, sweep, RELEASE), [expected].flat());
  });
}

// The benign cases, so the sweeps above are known to be strict rather than
// merely brittle: read grants in any spelling, an empty block, and comments
// that name what they forbid.
test("read grants, empty blocks and comments pass", () => {
  for (const [from, to, sweep] of [
    [DEFAULT_TOKEN, "permissions: read-all\n", defaultPermissionViolations],
    [DEFAULT_TOKEN, `${DEFAULT_TOKEN}  # never write here\n  actions: read\n`, defaultPermissionViolations],
    [BUILD_HEADER, `${BUILD_HEADER}    permissions: {}\n`, writeScopeViolations],
    [BUILD_HEADER, `${BUILD_HEADER}    permissions: { contents: read, pull-requests: read }\n`, writeScopeViolations],
    [NPM_TEST, `${NPM_TEST}      # no secrets.ANY here, and no pull_request_target\n`, secretViolations],
    [NPM_TEST, `${NPM_TEST}      # no pull_request_target or workflow_run either\n`, triggerViolations],
    [NPM_TEST, `${NPM_TEST}      - run: npm run check-secrets # github.token stays unread\n`, secretViolations],
    ["  pull_request:\n    branches: [main]\n", "  pull_request: { branches: [main] }\n", pullRequestViolations],
  ] satisfies Array<[string, string, Sweep]>) {
    assert.deepEqual(mutatedViolations(from, to, sweep), [], to);
  }
  for (const [from, to] of [
    [NPM_ENV, `${NPM_ENV}          # no secrets.EXTRA_TOKEN here\n`],
    [GHCR_PASSWORD, `${GHCR_PASSWORD}      # github.token stays unread\n`],
  ]) {
    assert.deepEqual(mutatedViolations(from, to, releaseSecretViolations, RELEASE), [], to);
  }
});

// An allowlist row's two failure modes against a synthetic row beside the
// real ones: a grant it names passes, and a row whose grant is gone, or whose
// workflow is gone, is stale.
test("an allowlist row passes its grant and fails once the grant is gone", () => {
  const granted = `${BUILD_HEADER}    permissions:\n      contents: read\n      packages: write\n`;
  const row: GrantRow = [CI, "build", "packages"];
  assert.deepEqual(mutatedViolations(BUILD_HEADER, granted, (dir) => writeScopeViolations(dir, [...WRITE_ALLOWLIST, row])), []);
  assert.deepEqual(writeScopeViolations(workflowsDir, [...WRITE_ALLOWLIST, row]), [
    `${CI} job "build" does not grant packages: write, so its write-scope allowlist row is stale`,
  ]);
  assert.deepEqual(writeScopeViolations(workflowsDir, [...WRITE_ALLOWLIST, ["deploy.yml", "publish", "id-token"]]), [
    'deploy.yml job "publish" does not grant id-token: write, so its write-scope allowlist row is stale',
  ]);
});

// The secret allowlist's rows the same way: a synthetic row passes the read it
// names and is stale once the read is gone. Nothing here anchors on the npm
// token's line, so the first public PR removes that line and its row and
// nothing else. A read after jobs: is here too, since no one-for-one mutation
// can place it.
test("a secret allowlist row passes its read and fails once the read is gone", () => {
  const read = `${VERIFY_HEADER}    env:\n      T: \${{ secrets.NPM_TOKEN }}\n`;
  const row: SecretRow = ["verify", "NPM_TOKEN"];
  assert.deepEqual(
    mutatedViolations(VERIFY_HEADER, read, (dir) => releaseSecretViolations(dir, [...SECRET_ALLOWLIST, row]), RELEASE),
    [],
  );
  assert.deepEqual(releaseSecretViolations(workflowsDir, [...SECRET_ALLOWLIST, row]), [
    `${RELEASE} job "verify" does not read NPM_TOKEN, so its secret allowlist row is stale`,
  ]);

  const files = Object.fromEntries([...eachWorkflow(workflowsDir)].map(({ name, source }) => [name, source]));
  const trailing = `${files[RELEASE]}defaults:\n  run:\n    shell: \${{ secrets.EXTRA_TOKEN }}\n`;
  assert.deepEqual(fixtureViolations({ ...files, [RELEASE]: trailing }, releaseSecretViolations), [
    `${RELEASE} reads the secret EXTRA_TOKEN outside a job`,
  ]);
});
