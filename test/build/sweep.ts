/**
 * The plumbing the build sweeps share: which tracked files a sweep reads, and
 * which of their lines it flags. Each sweep keeps only its own paths, its own
 * test for a line and the way it words a hit.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The runtime sources as git pathspecs: every tracked source outside `test/`. */
export const RUNTIME_SOURCES = ["index.ts", "lib", "types", "smoke.ts", "scripts"];

/** A line a sweep flagged. `line` is 1-based and `text` is the line as written. */
export interface LineHit {
  path: string;
  line: number;
  text: string;
}

/** The tracked files under `paths` (git pathspecs), minus any in `skip`. */
export function trackedFiles(paths: readonly string[], skip: readonly string[] = []): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "" && !skip.includes(path));
}

/** The lines of `source` that `matches` flags, labelled with `path`. */
export function matchingLines(path: string, source: string, matches: (line: string) => boolean): LineHit[] {
  return source
    .split("\n")
    .flatMap((text, i) => (matches(text) ? [{ path, line: i + 1, text }] : []));
}

/** The lines `matches` flags across `files`, read from the repo root. */
export function sweepTree(files: readonly string[], matches: (line: string) => boolean): LineHit[] {
  return files.flatMap((path) => matchingLines(path, readFileSync(join(repoRoot, path), "utf8"), matches));
}
