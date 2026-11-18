# plex-mcp

An [MCP](https://modelcontextprotocol.io) server that gives your AI assistant
a complete picture of your Plex Media Server: every library, watched **and**
unwatched, every household member's watch history, plus safe curation writes
(playlists, collections, watched state, ratings, the plex.tv watchlist).

It talks to Plex's HTTP API directly (no client library, 2 runtime
dependencies), ships as an npm package and a Docker image, and is tested
offline.

Nothing in this server can delete, move, or modify media files or metadata.

## What you can ask

- "Which Scorsese films haven't I seen?"
- "Pick three unwatched 90s thrillers under 100 minutes."
- "What should I continue tonight?" (the next unwatched episode of each show)
- "Has anyone else watched Severance? Who's furthest along?"
- "What did the kids watch this month?"
- "What's new in the TV library this week?"
- "Make a collection of everything Denis Villeneuve directed that I haven't rated."

## How I build it

I build plex-mcp with AI coding assistants, mostly Claude Code, and hold the
work to the same bar I'd hold a team to:

- **Every change is a pull request.** Every job in [CI](#ci-and-releases) is a
  required check on `main`: type checks, the offline test suite, smoke tests of
  the npm package and the container image, and the MCP
  registry's check of `server.json`.
- **The rules are tests.** The project's conventions (actions pinned to commit
  SHAs, a read-only CI token, loopback-only examples, the voice of these docs)
  are checked in `npm test`, so an assistant can't drift from them unnoticed.
- **Releases need me.** Nothing ships from `main`. A release is cut by hand,
  carries build provenance, and goes live on npm only after I approve it with
  2FA.
- **Decisions are written down.** [docs/design-notes.md](docs/design-notes.md)
  records each bigger decision, the options I rejected, and why.

## Quick start

Requires Node 22+ and a Plex Media Server you own.

**1. Sign in and get your credentials** (plex.tv PIN flow, no token hunting):

```sh
npx @dustinhansen/plex-mcp login
```

It prints a link, waits for you to approve it in the browser, then prints
`PLEX_URL=…` and `PLEX_TOKEN=…`. Add `--write <file>` to append both lines to
a file as well. The file holds your token, so on macOS and Linux a new one is
created readable by you only. An existing file keeps its permissions.
`--write` refuses a file name that starts with `-`, so pass it as `./-name`. (Prefer
the manual route? Plex Web → play any item → ⋮ → Get Info → View XML →
`X-Plex-Token` in the URL.)

**2. Add it to your client.** Any MCP client that can launch a local
(stdio) server works. Most of them take the server as a command, its
arguments and an environment. Here are 2 CLIs, for example:

```sh
# Claude Code
claude mcp add plex -e PLEX_URL=http://<plex-host>:32400 -e PLEX_TOKEN=<token> -- npx -y @dustinhansen/plex-mcp

# Codex
codex mcp add plex --env PLEX_URL=http://<plex-host>:32400 --env PLEX_TOKEN=<token> -- npx -y @dustinhansen/plex-mcp
```

Clients configured with a JSON file (Claude Desktop, Cursor, and any client
that reads a `.mcp.json`) mostly use this shape. Your client's docs say where
the file lives and whether it names the top-level key differently:

```json
{
  "mcpServers": {
    "plex": {
      "command": "npx",
      "args": ["-y", "@dustinhansen/plex-mcp"],
      "env": {
        "PLEX_URL": "http://<plex-host>:32400",
        "PLEX_TOKEN": "<token>"
      }
    }
  }
}
```

Assistants that run in a browser or on a phone (claude.ai, ChatGPT) can't
launch a local process. They need the server in HTTP mode, reachable from the
vendor's cloud. See [HTTP mode and Docker](#http-mode-and-docker) and
[docs/remote-access.md](docs/remote-access.md).

Use the server owner's admin token if you want every user's watch history.

## Tools

The server registers 22 tools by default, and the optional ones below add up
to 4 more. Each tool declares a title and all 4 MCP annotations (read-only,
destructive, idempotent, open-world). The spec tells clients to treat
annotations as hints, so the [Safety model](#safety-model) rests on what the
server registers.

### Browse & read

| tool | what it does |
|---|---|
| `list_libraries` | All sections with `libraryType` (Movies / TV Shows / Music / Photos / Other Videos), scanner type, agent, and whether a scan is running. |
| `list_media` | Any library, any kind (movie/show/season/episode/artist/album/track/collection). Filters: watched, rated, genre, year, decade, contentRating, collection, country, studio, label, maxDurationMin, addedSince, lastViewedBefore, lastViewedAfter. The last-viewed filters take an ISO date or a relative value like `-3y`. A never-watched item counts as last viewed before any date, so pair `lastViewedBefore` with `watched: "watched"` to leave those out. Sorts: title, year, rating, audienceRating, userRating, addedAt, lastViewedAt, viewCount, duration, random. A `filters` object names what each `genre`, `collection`, `country`, `studio` or `label` filter matched, so you can see when a name matched a longer one. `collection` with no `kind` lists the kind the collection holds, so an episode collection in a TV library lists episodes. A smart collection with no tag is an error naming the ratingKey to pass to `get_children`. Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `search` | Global search across libraries incl. people, collections, playlists. `externalId` (`imdb:tt0113277`, `tmdb:949`, `tvdb:12345`) looks a movie or show up by the id Plex holds for it instead. |
| `get_item` | Full metadata + file info (paths, codecs, sizes, every version) by ratingKey. `labels` names the item's Plex labels, and is an empty array when it has none. |
| `get_children` | Children of a show (seasons), season (episodes), artist (albums), album (tracks), collection (items) or playlist (items, with `playlist: true`). A movie, episode or track has no children, and the call fails saying so. Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `get_extras` | Trailers, featurettes, behind-the-scenes for an item. |
| `person_credits` | Filmography by director/actor/writer/composer, with watched filter. Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `library_changes` | What's new or updated since a cutoff (`-7d` or ISO date), as an `added` and an `updated` list, each capped by `limit`. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25 for each list. |
| `library_stats` | Totals watched and unwatched, with genre/decade/rating breakdowns and optional per-user play counts. |

### Discover

| tool | what it does |
|---|---|
| `similar_items` | Plex's "more like this" for an item, with a watched filter. |
| `random_pick` | N random items matching any `list_media` filter set ("surprise me, unwatched, 80s, under 2h"). Each pick is the same record `list_media` returns. `filters` names what the tag filters matched, as in `list_media`, and `collection` with no `kind` picks the kind the collection holds. A smart collection with no tag is an error naming the ratingKey to pass to `get_children`. `detail: true` adds fields such as cast, crew and a summary to each record. `user` picks as a Plex Home user, so unwatched means unwatched by them. |
| `continue_watching` | Plex's Continue Watching row: the next unwatched episode per in-progress show and any partially watched movie, with how far into each you are. `detail: true` returns full item records instead, and caps `limit` at 25. |
| `get_watchlist` | The server owner's plex.tv watchlist, with whether each title is in a library here and its ratingKey if so. Paginated (`offset`/`limit`). |

There are also two MCP prompts, `movie_night` and `whats_new`, and a
`plex://libraries` resource.

### History & household

| tool | what it does |
|---|---|
| `watch_history` | Who watched what, and when. Filter by user, library, time window, or item. |
| `now_playing` / `list_users` | Live sessions and every account on the server. |

`continue_watching`, `list_media`, `random_pick` and `library_stats` accept
a `user` argument to see the library as a **Plex Home** user (their watched
state, their on-deck). Plex only allows this for Home (managed) users. For
friends, `watch_history` is the view that works for everyone.

### Curate (writes)

Registered unless `PLEX_READ_ONLY=1`.

| tool | what it does |
|---|---|
| `set_watched` | Mark items watched/unwatched (explicit ratingKeys only). |
| `rate_item` | Set or clear the server owner's star rating. |
| `manage_playlist` / `manage_collection` | Create, add, remove, delete. Deleting removes only the grouping, never media. |
| `manage_watchlist` | Add movies and shows in the library to the server owner's plex.tv watchlist, or remove them (explicit ratingKeys only). |
| `scan_library` | Trigger "Scan Library Files" for a section, optionally one folder. |

`manage_watchlist` resolves each ratingKey to the Plex GUID plex.tv identifies
the item by. It takes movies and shows only, the kinds a Plex watchlist
offers, and refuses an item matched by a legacy agent (which has no Plex
GUID). Both checks run before anything is sent.

### Optional: playback (off by default)

Set `PLEX_ALLOW_PLAYBACK=1` to register `list_clients` and `play_item`
("play this album on my phone"). Both tools use Plex's player-control API, so
the target must be a player that advertises itself to the server. I have
tested playback with Plexamp. Current Plex apps for TVs and desktops may not
show up in `list_clients` at all: Plex for Apple TV and Plex for Mac did not,
even with the app open. Off by default because it's the one thing here that
touches the real world. `PLEX_READ_ONLY=1` keeps them unregistered even when
this is set.

### Optional: Tautulli

Set `TAUTULLI_URL` and `TAUTULLI_API_KEY` to add `tautulli_stats` (home
stats: most watched, most active users, popular items over a period) and
`tautulli_history` (per-play records with platform, player, and percent
watched). Plex's own history covers the basics. Tautulli adds the detail
most admins already collect. They need Tautulli 2.18.0 or later, the first
release that reads the API key from a request header.

## Safety model

- **No media mutations.** There is no code path that deletes, moves,
  renames, or edits media files or metadata. Playlist/collection deletion
  removes the grouping only.
- **Writes are explicit.** Every write names its targets: items by ratingKey,
  a playlist or collection by id, and a library by title. A library scan can
  narrow to one folder. Creating a collection names its library too: several
  read tools default to Movies because a read changes nothing, but a write
  never picks its own target. The collection's kind is not a target: it
  follows the named library (movie, show, or album for a music library), so it
  always agrees with where the collection goes. A `kind` that
  contradicts the library is refused before the write, and so is a library
  type that holds no collection kind the tool offers.
  Nothing operates on "all matches".
- **Playback is opt-in** via an environment variable. The tools aren't
  registered without it.
- **`PLEX_READ_ONLY=1` removes every write.** The curation writes and the
  playback tools are not registered, whatever `PLEX_ALLOW_PLAYBACK` says, so a
  client sees only reads. The Tautulli tools are reads and stay. The
  restriction wins over the opt-in because a server set up to change nothing
  should not start changing things when another variable is added. Any value
  other than `1`, `0` or empty stops the server rather than starting it with
  writes.
- **Ids are a run of digits.** A tool refuses any ratingKey, playlist id or
  collection id with anything else in it before the request reaches Plex (the
  client also refuses a request path that does not resolve to itself). I
  made this decision because a tool puts the id into the request path, and
  Plex marks an item watched, rates it and refreshes a library over GET. An
  id carrying `..` or `?` could turn a read into one of those writes, even
  with `PLEX_READ_ONLY=1`. I refuse a bad id rather than encode it, because
  no real Plex id needs encoding.
- **Errors never echo upstream response bodies** from Plex, plex.tv or
  Tautulli, which can contain server paths and configuration. A failed
  request names the upstream, the path and either the HTTP status or the
  network cause, such as `Plex unreachable (ECONNREFUSED) on
  /library/sections` when `PLEX_URL` points at the wrong host or port.
- **HTTP mode refuses to start without a secret.** See below.

## HTTP mode and Docker

By default the server speaks MCP over stdio. Set `MCP_TRANSPORT=http` to
serve streamable HTTP on `PORT` (default 8627) with a `/health` endpoint.
This is what the Docker image does. It implements MCP protocol revision
2025-11-25, the one the SDK's 1.x line speaks. Outside the image, HTTP mode listens on `127.0.0.1` only. Set
`MCP_HOST=0.0.0.0` to accept connections from other machines. The image is
published to
`ghcr.io/dustinhansen/plex-mcp` for `linux/amd64` and `linux/arm64`, so the
usual setup is Docker Compose on whatever already runs your containers:

```yaml
services:
  plex-mcp:
    image: ghcr.io/dustinhansen/plex-mcp:latest
    hostname: plex-mcp
    restart: unless-stopped
    ports:
      - "127.0.0.1:8627:8627"
    environment:
      PLEX_URL: ${PLEX_URL:?}
      PLEX_TOKEN: ${PLEX_TOKEN:?}
      MCP_PATH_SECRET: ${MCP_PATH_SECRET:?}
```

The port is published on `127.0.0.1` only, so nothing beyond this host can
reach it. To reach it from other machines on your LAN, see
[docs/remote-access.md](docs/remote-access.md#publishing-the-port-beyond-this-host).

The `${VAR:?}` form makes a missing value fail the deploy loudly instead
of starting an unauthenticated container. `hostname` keeps the identifier the
container sends plex.tv the same when it is recreated (see
[Client identifier](docs/design-notes.md#client-identifier)). The image carries
its own `HEALTHCHECK` against `/health`, so the service needs no `healthcheck:` block.
Put the 3 values in a `.env` next to the compose file (never in the image
or a repo):

```sh
PLEX_URL=http://<plex-host>:32400
PLEX_TOKEN=<token>                        # from `npx @dustinhansen/plex-mcp login`
MCP_PATH_SECRET=$(openssl rand -hex 32)   # the endpoint's only auth, so treat it as a password
```

To try it without compose:

```sh
docker run --rm --hostname plex-mcp -p 127.0.0.1:8627:8627 \
  -e PLEX_URL=http://<plex-host>:32400 -e PLEX_TOKEN=<token> \
  -e MCP_PATH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/dustinhansen/plex-mcp:latest
```

The MCP endpoint is `http://127.0.0.1:8627/<MCP_PATH_SECRET>/mcp`. The secret is
the only auth on a write-capable endpoint, so the server refuses to start
in HTTP mode without one (`MCP_ALLOW_NO_AUTH=1` overrides, for listeners
that are unreachable from untrusted networks).

- [docs/remote-access.md](docs/remote-access.md): connecting a desktop or
  cloud-hosted MCP client to an HTTP-mode server over your LAN or a public
  HTTPS endpoint, and what the security trade-offs are.
- [docs/docker.md](docs/docker.md): more on the compose setup, keeping
  the image up to date (Watchtower/Diun, version pinning) and building
  locally.

## Environment variables

| variable | required | purpose |
|---|---|---|
| `PLEX_URL` | yes | e.g. `http://<plex-host>:32400` (a value that is not an `http` or `https` URL is refused at startup) |
| `PLEX_TOKEN` | yes | owner/admin `X-Plex-Token` |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` (any other value is refused at startup) |
| `PORT` | no | HTTP listen port, an integer from 0 to 65535 (default 8627) |
| `MCP_HOST` | no | HTTP listen address (default `127.0.0.1`, or `0.0.0.0` in the image) |
| `MCP_PATH_SECRET` | http mode | capability-URL secret, required in http mode (at least 16 characters of letters, digits, `-`, `_`, `.` or `~`) |
| `MCP_ALLOW_NO_AUTH` | no | `1` to run http mode without a secret (trusted networks only) |
| `PLEX_ALLOW_PLAYBACK` | no | `1` registers `list_clients` / `play_item` |
| `PLEX_READ_ONLY` | no | `1` registers no write or playback tools, whatever `PLEX_ALLOW_PLAYBACK` says (`0`, empty or unset registers them) |
| `TAUTULLI_URL`, `TAUTULLI_API_KEY` | no | registers the Tautulli tools when both are set (one alone is refused at startup, as is a `TAUTULLI_URL` that is not an `http` or `https` URL) |

## Verifying what you install

Both artifacts are built and published by `release.yml` from a tagged commit
of this repository, and each carries provenance that says so.

- **npm.** The package page on npmjs.com shows a provenance badge for each
  version. In a project that has the package installed, `npm audit signatures`
  checks the registry signatures and the provenance attestation.
- **Image.** `gh attestation verify
  oci://ghcr.io/dustinhansen/plex-mcp:vX.Y.Z --repo dustinhansen/plex-mcp`
  checks the image's build provenance against this repository.

## CI and releases

`.github/workflows/ci.yml` runs on every pull request into `main`, every push
to `main` and on demand, on GitHub-hosted runners only:

- `build`: the type checks, the compile-only type fixtures and the offline
  test suite (`npm test`), on Node 22.
- `artifact-smoke`: the packed npm tarball installed with `--omit=dev
  --offline` and started over stdio, on Node 22 (the `engines` floor),
  Node 24 and Node 26 (LTS lines newer than the floor).
- `container-smoke`: the image built for `linux/amd64` and `linux/arm64`,
  each on a runner of that architecture with no emulation, then booted
  against a local Plex fixture.
- `server-json`: `server.json` checked by the MCP registry's validate
  endpoint with `mcp-publisher validate`, the same pinned release
  `release.yml` publishes with. It sends the file to the registry and
  publishes nothing.

Its token is read-only and no job reads a secret, so a pull request from a
fork runs every check. `test/build/workflow-contract.test.ts`, part of
`npm test`, holds both workflows to their shape: actions pinned to full commit
SHAs, a timeout on every job, a read-only default token, and write scopes and
release secrets only where an allowlist names them.

`.github/workflows/release.yml` runs only when a GitHub release is published
by hand. It re-runs the CI checks against the tag, checks the tag against
every version field, then stages the npm version and publishes the image. The
npm version goes live once I approve it on npm with 2FA. After that I approve
the `registry` job, which publishes the registry entry:

| release | npm `@dustinhansen/plex-mcp` | image `ghcr.io/dustinhansen/plex-mcp` | MCP registry |
|---|---|---|---|
| `vX.Y.Z` | `X.Y.Z` on dist-tag `latest`, with provenance | `:vX.Y.Z` for amd64 and arm64, attested, and `:latest` moves to it | `io.github.dustinhansen/plex-mcp` at `X.Y.Z` |
| `vX.Y.Z-rc.N`, marked prerelease | `X.Y.Z-rc.N` on dist-tag `next`, with provenance | `:vX.Y.Z-rc.N`, attested, and `:latest` stays put | not published |

The release checklist and the repository's settings are in
[docs/publishing.md](docs/publishing.md).

## Development

```sh
npm install
npm test          # build emitted JavaScript, then run offline compatibility tests
npm run smoke     # build, then live checks against a real server (needs PLEX_URL + PLEX_TOKEN)
```

The smoke suite checks every `list_media` filter against a live server:
watched, rated, year, decade, genre, content rating, collection, country,
studio, label, duration, added-since, last-viewed-before and last-viewed-after.
It checks a Home user's view too, when there is one. Each filter check needs a
match, except unwatched and unrated. Unwatched plus watched must equal the
whole library, and so must unrated plus rated. When the server has nothing to
test a filter with, the check logs a skip line naming the filter.

It also checks `get_children` on 1 regular, 1 episode and 1 smart collection,
because Plex has 2 paths to a collection's members and neither one always
answers. Each total must equal the collection's own `childCount`. If the server
has no collection with members for one of those, the check logs a skip line
naming it.

[CHANGELOG.md](CHANGELOG.md) tracks releases.

## Design notes

[docs/design-notes.md](docs/design-notes.md) records the bigger decisions,
what I rejected, and why. The short version:

- **A small tool surface.** Every registered tool costs your client context, so
  new capability goes in as a parameter on an existing tool first.
- **Safe by default.** Loopback-only examples, a required secret in HTTP mode,
  ids checked before any request, and no media mutation.
- **Traceable releases.** Everything published comes from a tagged release,
  with provenance and a 2FA approval on npm.
- **Plex quirks handled in the server.** Paging headers, tag lookups, the 2
  paths to a collection's members, and Plex Home user switching.

Out of scope: media mutation of any kind (see [Safety model](#safety-model))
and Plex server administration.

## License

MIT. See [LICENSE](LICENSE).
