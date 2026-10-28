// The release workflow's verify job, run against the real files and against
// copies with one field changed, so each field it compares is shown to be read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFiles, releaseTagViolations, type ReleaseFiles } from "../../scripts/verify-release-tag.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/verify-release-tag.ts", import.meta.url));
const files = () => readFiles(repoRoot);
const version = files().pkg.version!;
const entry = (f: ReleaseFiles, registryType: string) => f.server.packages!.find((p) => p.registryType === registryType)!;

// The script as the workflow runs it, with its exit code and both streams.
function run(...args: string[]) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const failed = error as { status: number | null; stderr: string };
    return { code: failed.status, out: failed.stderr };
  }
}

test("the tag for package.json's version passes", () => {
  assert.deepEqual(releaseTagViolations(`v${version}`, "false", files()), []);
  assert.deepEqual(run(`v${version}`, "false"), { code: 0, out: `verify: v${version} matches every version field\n` });
});

test("a tag that differs from package.json's version fails and names every field", () => {
  const { code, out } = run("v9.9.9", "false");
  assert.equal(code, 1);
  for (const label of [
    "package.json version",
    "package-lock.json version",
    'package-lock.json packages[""].version',
    "server.json version",
    "server.json npm package version",
    "server.json image tag",
  ]) {
    assert.ok(out.includes(`verify: ${label}`), `${label} missing from:\n${out}`);
  }
});

test("each version field is compared on its own", () => {
  const edits: Array<[label: string, edit: (f: ReleaseFiles) => void]> = [
    ["package.json version", (f) => (f.pkg.version = "0.0.1")],
    ["package-lock.json version", (f) => (f.lock.version = "0.0.1")],
    ['package-lock.json packages[""].version', (f) => (f.lock.packages![""]!.version = "0.0.1")],
    ["server.json version", (f) => (f.server.version = "0.0.1")],
    ["server.json npm package version", (f) => (entry(f, "npm").version = "0.0.1")],
    ["server.json image tag (ghcr.io/dustinhansen/plex-mcp:v…)", (f) => (entry(f, "oci").identifier = "ghcr.io/dustinhansen/plex-mcp:v0.0.1")],
  ];
  for (const [label, edit] of edits) {
    const changed = files();
    edit(changed);
    assert.deepEqual(releaseTagViolations(`v${version}`, "false", changed), [`${label} is "0.0.1", not "${version}" from tag "v${version}"`]);
  }
});

test("an image under another name is reported whole", () => {
  const changed = files();
  entry(changed, "oci").identifier = `ghcr.io/someone/plex-mcp:v${version}`;
  assert.deepEqual(releaseTagViolations(`v${version}`, "false", changed), [
    `server.json image tag (ghcr.io/dustinhansen/plex-mcp:v…) is "ghcr.io/someone/plex-mcp:v${version}", not "${version}" from tag "v${version}"`,
  ]);
});

test("a tag that is not v<semver> fails", () => {
  assert.deepEqual(releaseTagViolations(version, "false", files()).slice(0, 1), [`tag "${version}" is not v<semver>`]);
});

test("the prerelease flag has to agree with the version", () => {
  const rc = files();
  for (const f of [rc.pkg, rc.lock, rc.lock.packages![""]!, rc.server, entry(rc, "npm")]) f.version = "1.0.0-rc.1";
  entry(rc, "oci").identifier = "ghcr.io/dustinhansen/plex-mcp:v1.0.0-rc.1";

  assert.deepEqual(releaseTagViolations("v1.0.0-rc.1", "true", rc), []);
  assert.deepEqual(releaseTagViolations("v1.0.0-rc.1", "false", rc), [
    '"1.0.0-rc.1" is a prerelease version but the release is not marked prerelease',
  ]);
  assert.deepEqual(releaseTagViolations(`v${version}`, "true", files()), [
    `the release is marked prerelease but "${version}" has no prerelease part`,
  ]);
  assert.deepEqual(releaseTagViolations(`v${version}`, "", files()), [`the release's prerelease flag is "", not "true" or "false"`]);
});
