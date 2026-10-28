# AGENTS.md

plex-mcp is an MCP server for one Plex Media Server, written in TypeScript and
compiled to `dist/`.

## Commands

```sh
npm test            # build, then run the offline test suite
npm run typecheck   # tsc over the runtime, then over the tests
npm run smoke       # build, then live checks against a real server — needs PLEX_URL + PLEX_TOKEN
```

`npm test` and `npm run typecheck` need no Plex server. `npm run smoke` talks to
a real one and makes a reversible write round-trip, so run it only against a
server you are allowed to change.

On Node 26, a failure at a test file's `:1:1` that reads

```
'Promise resolution is still pending but the event loop has already resolved'
```

means the test runner was signaled (SIGTERM or SIGINT) partway through, not that
a test hangs. You can tell by an `Interrupted while running:` block above the
summary and a `duration_ms` well under a normal full run.

## Rules

- **Two runtime dependencies.** `@modelcontextprotocol/sdk` and `zod` are the
  only entries in `dependencies`. A new one needs a strong case.
- **Nothing mutates media.** No code path deletes, moves, renames or edits
  media files or metadata. Every write names its targets explicitly. See the
  README's [Safety model](README.md#safety-model).
- **Tests use `node:test` with an injected `fetch`.** No test framework and no
  mocking library. Code that reaches the network takes a `fetchImpl`, and tests
  pass a fake one. Tool tests may fake the client above it instead.
- **Comments explain the code, never its history.** No ticket numbers, past
  versions, migrations or dated "verified" notes. Keep the fact and drop the
  story. `test/build/narration.test.ts` fails on the common markers.
- **Docs are plain and first person.** A decision says who made it, the
  stock words of generated prose stay out, and a date goes only in a
  CHANGELOG heading (an MCP protocol revision is a name, not a date).
  `test/build/doc-voice.test.ts` lists the patterns and fails on them. It
  reads the issue forms under `.github/ISSUE_TEMPLATE/` too, because they're
  public text in the project's voice and the first thing a bug reporter reads.
  It reads the `description` strings in `package.json` and `server.json` and
  the comments in `.env.example` as well, because they're the npm and MCP
  registry listings and the template a self-hoster fills in.

## Where to read more

- [CONTEXT.md](CONTEXT.md) is the glossary: the terms the tools, docs and code
  share.
- The README's [Design notes](README.md#design-notes) hold the reasons behind
  the tool surface and these rules.
