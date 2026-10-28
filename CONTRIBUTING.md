# Contributing

## How this project is maintained

plex-mcp is a one-person project. I built it for my own Plex server and
published it because it seemed useful to other people. I maintain it on a
best-effort basis: I triage issues and pull requests by hand when I have
time, and I make no promise about how quickly that happens. Some weeks
it's a day, some months it's nothing at all.

That is the whole social contract. Nothing here is abandoned, and nothing
here is staffed. If you need a guaranteed fix on a schedule, fork it. The
license allows it and I won't be offended.

## Reporting a bug

Open an issue using the bug report template. It asks for the transport
(stdio or HTTP), how you installed, the server version, and your Plex
Media Server version, because nearly every bug turns on one of those 4.
Including them saves a round trip.

**Security issues don't go here.** See [SECURITY.md](SECURITY.md) for the
private reporting path. This server holds a Plex token, so please don't
open a public issue for anything security-sensitive.

## Pull requests

PRs that fix bugs are welcome and reviewed on the same best-effort basis
as issues. Open an issue first, using the bug report template, before you
write the fix. That way we agree it's a bug and agree on the shape of the fix
before you spend the time.

I'm not taking unsolicited new tools or features. I keep the tool surface
small on purpose, because a set of tools a model can hold in context beats
exhaustive coverage of the Plex API. A request for new capability starts with
the feature request template, which asks what you'd use it for. That lets us
agree on whether it belongs, and which existing tool could take it as a
parameter, before anyone writes code. I'll decline a PR that adds tools
without a request we've agreed on, even if the code is good. That is a
judgment about the project, not about your work.

Before you start, there are 2 constraints worth knowing:

- **Runtime dependencies stay at 2** (`@modelcontextprotocol/sdk` and
  `zod`). A PR that adds a third needs to argue for it.
- **Nothing may mutate media.** No code path deletes, moves, renames, or
  edits media files or metadata. See the safety model in the
  [README](README.md#safety-model).

## Working on the code

Requires Node 22.18 or later, the first 22.x that runs `.ts` files without a
flag. The published package itself runs on any Node 22.

```sh
npm install
npm test          # offline unit tests (node --test)
npm run typecheck # the runtime and the tests
npm run smoke     # build, then live checks against a real server (needs PLEX_URL + PLEX_TOKEN)
```

Every test lives under `test/` and is TypeScript that Node runs directly,
against the built `dist/`. Unit tests sit at the top. The checks on the build,
workflows and release files are in `test/build/`, and the compile-only type
fixtures are in `test/types/`. Tests use `node:test` and `node:assert/strict`
with no test framework, and mock Plex by injecting a `fetch`. New behavior
should come with a test. Follow whatever the nearest existing test file does.

There is no linter or formatter, so match the style of the file you're
editing. The reasoning behind the bigger decisions is in the README's
[Design notes](README.md#design-notes).
