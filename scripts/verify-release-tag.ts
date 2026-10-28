#!/usr/bin/env node
// The release workflow's verify job: a release tag publishes only when it is
// `v` plus every version field the release ships. npm, the image tag and the
// MCP registry entry each read a different one of those fields, so a tag that
// disagrees with any of them would publish three artifacts under two versions.
// The unit test in test/server.test.ts holds the files to each other. This
// adds the tag, which only exists once a release is published.
//
//   node scripts/verify-release-tag.ts <tag> <prerelease>
//
// <prerelease> is the release's own flag, "true" or "false". It decides npm's
// dist-tag, whether the image moves :latest and whether the registry entry is
// published, so it has to agree with the version: a 0.9.1-rc.1 released as
// final would become the version every `npx` and `docker pull` gets.
//
// Exits 1 listing every disagreement, or 0 printing the version.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = "ghcr.io/dustinhansen/plex-mcp";

interface VersionedPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
}

// The parsed package.json, package-lock.json and server.json.
export interface ReleaseFiles {
  pkg: { version?: string };
  lock: { version?: string; packages?: Record<string, { version?: string } | undefined> };
  server: { version?: string; packages?: VersionedPackage[] };
}

// Every version field, as a label and the value the files hold for it.
function versionFields({ pkg, lock, server }: ReleaseFiles): Array<[label: string, value: string | undefined]> {
  const npm = server.packages?.find((entry) => entry.registryType === "npm");
  const oci = server.packages?.find((entry) => entry.registryType === "oci");
  const ociTag = oci?.identifier?.startsWith(`${IMAGE}:v`) ? oci.identifier.slice(`${IMAGE}:v`.length) : oci?.identifier;
  return [
    ["package.json version", pkg.version],
    ["package-lock.json version", lock.version],
    ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
    ["server.json version", server.version],
    ["server.json npm package version", npm?.version],
    [`server.json image tag (${IMAGE}:v…)`, ociTag],
  ];
}

export function releaseTagViolations(tag: string, prerelease: string, files: ReleaseFiles) {
  const violations: string[] = [];
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    violations.push(`tag "${tag}" is not v<semver>`);
  }
  const version = tag.replace(/^v/, "");
  for (const [label, value] of versionFields(files)) {
    if (value !== version) violations.push(`${label} is "${value}", not "${version}" from tag "${tag}"`);
  }
  if (prerelease !== "true" && prerelease !== "false") {
    violations.push(`the release's prerelease flag is "${prerelease}", not "true" or "false"`);
  } else if (version.includes("-") !== (prerelease === "true")) {
    violations.push(
      prerelease === "true"
        ? `the release is marked prerelease but "${version}" has no prerelease part`
        : `"${version}" is a prerelease version but the release is not marked prerelease`,
    );
  }
  return violations;
}

export function readFiles(root: string): ReleaseFiles {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(root, name), "utf8"));
  return { pkg: read("package.json"), lock: read("package-lock.json"), server: read("server.json") } as ReleaseFiles;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag = "", prerelease = ""] = process.argv.slice(2);
  const violations = releaseTagViolations(tag, prerelease, readFiles(fileURLToPath(new URL("..", import.meta.url))));
  if (violations.length > 0) {
    for (const violation of violations) console.error(`verify: ${violation}`);
    process.exit(1);
  }
  console.log(`verify: ${tag} matches every version field`);
}
