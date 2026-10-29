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

## Quick start

Requires Node 22+ and a Plex Media Server you own.

**1. Sign in and get your credentials** (plex.tv PIN flow, no token hunting):

```sh
npx @dustinhansen/plex-mcp login
```

It prints a link, waits for you to approve it in the browser, then prints
`PLEX_URL=…` and `PLEX_TOKEN=…`. Add `--write <file>` to append both lines to
a file as well. The file holds your token, so on macOS and Linux a new one is
created readable by you only. An existing file keeps its permissions. (Prefer
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
| `list_media` | Any library, any kind (movie/show/season/episode/artist/album/track/collection). Filters: watched, rated, genre, year, decade, contentRating, collection, country, studio, maxDurationMin, addedSince, lastViewedBefore, lastViewedAfter. The last-viewed filters take an ISO date or a relative value like `-3y`. A never-watched item counts as last viewed before any date, so pair `lastViewedBefore` with `watched: "watched"` to leave those out. Sorts: title, year, rating, audienceRating, userRating, addedAt, lastViewedAt, viewCount, duration, random. Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `search` | Global search across libraries incl. people, collections, playlists. `externalId` (`imdb:tt0113277`, `tmdb:949`, `tvdb:12345`) looks a movie or show up by the id Plex holds for it instead. |
| `get_item` | Full metadata + file info (paths, codecs, sizes, every version) by ratingKey. |
| `get_children` | Children of a show (seasons), season (episodes), artist (albums), album (tracks), collection (items) or playlist (items, with `playlist: true`). Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `get_extras` | Trailers, featurettes, behind-the-scenes for an item. |
| `person_credits` | Filmography by director/actor/writer/composer, with watched filter. Paginated (`offset`/`limit`/`nextOffset`). `fields` projects each record to the keys you need. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25. |
| `library_changes` | What's new or updated since a cutoff (`-7d` or ISO date), as an `added` and an `updated` list, each capped by `limit`. `detail: true` adds fields such as cast, crew and a summary to each record, and caps `limit` at 25 for each list. |
| `library_stats` | Totals watched and unwatched, with genre/decade/rating breakdowns and optional per-user play counts. |

### Discover

| tool | what it does |
|---|---|
| `similar_items` | Plex's "more like this" for an item, with a watched filter. |
| `random_pick` | N random items matching any `list_media` filter set ("surprise me, unwatched, 80s, under 2h"). Each pick is the same record `list_media` returns. `detail: true` adds fields such as cast, crew and a summary to each record. `user` picks as a Plex Home user, so unwatched means unwatched by them. |
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
the target must be a player that advertises itself to the server. We have
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
  client also refuses a request path that does not resolve to itself). We
  made this decision because a tool puts the id into the request path, and
  Plex marks an item watched, rates it and refreshes a library over GET. An
  id carrying `..` or `?` could turn a read into one of those writes, even
  with `PLEX_READ_ONLY=1`. We refuse a bad id rather than encode it, because
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
2025-11-25, the one the SDK's 1.x line speaks, not the newer 2026-07-28
revision. Outside the image, HTTP mode listens on `127.0.0.1` only. Set
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
[Client identifier](#client-identifier)). The image carries its own
`HEALTHCHECK` against `/health`, so the service needs no `healthcheck:` block.
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
  --offline` and started over stdio, on Node 22 (the `engines` floor) and
  Node 24 (an LTS line newer than the floor).
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
studio, duration, added-since, last-viewed-before and last-viewed-after. It
checks a Home user's view too, when there is one. Each filter check needs a
match, except unwatched and unrated. Unwatched plus watched must equal the
whole library, and so must unrated plus rated. When the server has nothing to
test a filter with, the check logs a skip line naming the filter.

[CHANGELOG.md](CHANGELOG.md) tracks releases.

## Design notes

### Limited surface area

plex-mcp registers a small set of tools rather than covering the whole Plex
API. We made this decision because every registered tool costs your MCP client
context before a single call is made, and a model does better with a set it can
hold in context. We try new capability first as a parameter on an existing
tool. You'll see that `list_media` carries the filters a dozen per-kind tools
would otherwise have spread out. The same rule gives each Plex list 1 tool.
`continue_watching` reads the on-deck list, and we named it for the Continue
Watching row you see in Plex's UI. Its `detail` parameter returns the full item
records, so a second tool for the same list would add nothing. So if Plex can
do something the tools don't expose, that's something we left out on purpose.

But we're open to adding more surface in the future. Please open a
[feature request issue](https://github.com/dustinhansen/plex-mcp/issues/new?template=feature_request.yml)
and tell us what you'd use it for, because the use is what tells us which
existing tool could take it as a parameter. We take requests in the issue
tracker rather than GitHub Discussions, since that's the one place I triage.

### Tautulli

The Tautulli tools are here because they answer what Plex's own history can't.
Plex records who played what and when, but it only knows the player and how
far a play got while the session is live. Tautulli keeps the platform, player
and percent watched for every play, and ranks the most watched items and most
active users over however many days you ask for. No parameter on an existing
tool could return that.

They still fit the limited surface. Neither tool is registered unless you set
both `TAUTULLI_URL` and `TAUTULLI_API_KEY`, so they cost your client no context
otherwise. Both are reads, so they stay under `PLEX_READ_ONLY=1`, and the
Safety model's rule against echoing upstream response bodies covers them.

The API key travels in the `X-Api-Key` header and never in the request URL. We
made this decision because a URL lands in the logs of any proxy between
plex-mcp and Tautulli, and in Tautulli's own access log, while a header
usually does not. Tautulli's API reference prefers the header for the same
reason. Tautulli reads the header from 2.18.0 on, so that version is the
minimum. If you run an older Tautulli, every call fails with a missing-key
error (HTTP 400), and the error tells you to check the version first. We
rejected keeping the key in the URL and saying so, because that documents the
exposure instead of removing it. We also rejected trying the header first and
falling back to the URL, because the fallback could not tell an older Tautulli
from a wrong key or a bad request, and each time it ran it would put the key
back in the URL.

### Watchlist

The watchlist takes library items only. We made this decision because any
write that picks its target from search results breaks the rule that every
write names its targets. You'll see that `manage_watchlist` names items by
ratingKey like every other write, and a title in no library here has no
ratingKey (adding one would need a plex.tv Discover search by title).
`get_watchlist` still shows those titles, with `ratingKey` null.

The list itself lives on plex.tv, not on your server. It sits with the
curation writes anyway, because it's the server owner's "I want to watch this"
list.

### Remote access

Remote access works by capability URL, and the server checks the secret
itself. We put the check in-process because any reverse proxy that forwards
all paths publishes every path, bare `/mcp` included. The path secret in the
endpoint's URL authorizes every request. The default transport, stdio, has no
network surface at all. HTTP mode is streamable HTTP (not the deprecated SSE
transport) and stateless (every request builds a fresh server, and all real
state lives in Plex). See [docs/remote-access.md](docs/remote-access.md).

HTTP mode follows the transport's 2 local-safety rules. It listens on loopback
unless `MCP_HOST` says otherwise, and it answers 403 to a browser `Origin` that
isn't loopback, the specific address `MCP_HOST` names, or `null`. A wildcard
`MCP_HOST` such as the image's `0.0.0.0` names no address. The check stops DNS
rebinding (a rebound page's `Origin` names the attacker's domain), and it runs
before the path secret is checked. We rejected matching the request's `Host`
header instead, because a rebound request's `Host` names the same domain and
would get through. A `null` origin, sent by local files and sandboxed pages,
passes. The server sends no CORS headers, so such a page can't read the
response, and it still needs the secret. There is no allowed-origins setting.
The clients in [docs/remote-access.md](docs/remote-access.md) are not browser
pages and send no `Origin`, so if you host a browser client on some other
domain, it's refused.

The listen address is `MCP_HOST`, not the generic `HOST`. We named it that
because a shell or CI environment may export `HOST` for its own reasons, and an
inherited `HOST=0.0.0.0` would silently move the bind address off loopback. So
the server ignores `HOST`. We kept `PORT` under its plain name because an
inherited port can make the server unreachable, but it can't move it off
loopback.

### Optional spec features

We left a few optional MCP spec features out on purpose. No tool declares an
`outputSchema`, because claude.ai drops any tool whose output schema carries
the draft-07 `$schema` stamp the SDK adds. I found that on another MCP server
of mine. There are no sessions, because HTTP mode is stateless (above). There
is no per-tool rate limiting either. Over stdio there is 1 client and nothing
to limit, and over HTTP the path secret and the 1 MiB request-body cap are the
mitigations. On either transport, one tool call may carry at most 1000 array
elements and object members combined (twice the longest ratingKeys list any
tool takes), so a request under the body cap can't exhaust memory while its
arguments are checked.

But we're open to adding these in the future. If your client needs one, please
open a
[feature request issue](https://github.com/dustinhansen/plex-mcp/issues/new?template=feature_request.yml)
and say what it would let you do.

### Releases

Everything we publish comes from a release, never from `main`. We set it up
that way so the npm package and the image you install can each be traced back
to the tagged commit that built it (both carry build provenance). A GitHub
release, published by hand, is the only trigger for `release.yml`, which
stages the npm package and publishes the image and the registry entry.

The workflow can only stage an npm version, and it goes live once I approve it
on npm with 2FA. We set it up this way so that a compromised workflow, action
or GitHub account can't put a version on npm by itself. The registry entry
needs the npm version live, and npm sends no event when I approve one, so the
`registry` job runs in a GitHub environment that holds it until I approve it
there too. That's 2 approvals per final release (a prerelease skips the
registry), and I'm there for every release anyway. I rejected a separate
registry workflow started by hand after the npm approval, because it would need
its own copy of the prerelease guard. I also rejected a job that polls npm
until the version shows up, because it holds a runner the whole time and fails
if I'm slow to approve.

I cut releases by hand because release automation such as Release Please
opens its release PR from a workflow, and GitHub holds the checks on that PR
until someone approves them by hand, unless it is opened with a long-lived
token. I release occasionally and on my own, so the automation isn't worth
keeping that token around. CI runs only on GitHub-hosted runners, and the
arm64 image builds natively on an arm64 runner rather than under emulation.

### Registry entry

The registry entry lists the image beside the npm package. We list both
because an npm-only entry would hide the always-on HTTP server from anyone who
finds plex-mcp through the official MCP registry (the npm package runs over
stdio, 1 process per client). The image's entry describes the safe local
default: the port published on loopback only, and the path secret in the
endpoint URL. If you want LAN or remote exposure,
[docs/remote-access.md](docs/remote-access.md) covers it. The image carries
the `io.modelcontextprotocol.server.name` label the registry's package docs ask
for as proof of ownership, and a test keeps that label, `server.json`, and
`package.json`'s `mcpName` and version in step.

### Published port

Every copy-paste example here publishes the port on loopback only. We made
this decision because people copy from this page, so whatever the examples
publish becomes the default without anyone choosing it. The compose and
`docker run` examples here and in [docs/docker.md](docs/docker.md) publish
`127.0.0.1:8627:8627`, the same mapping as the registry entry, and a test keeps
all 3 in step. (The image sets `MCP_HOST=0.0.0.0`, since a container that
listens on its own loopback is unreachable through any port mapping, so the
mapping alone decides who can reach the server.)

We rejected keeping `8627:8627` in the examples and rewording the registry
note to say they expose the port to the LAN. The path secret still guards a
LAN-wide port. But the README would then describe a different safe default
from the registry entry's.

### Registry validation

Every pull request asks the registry whether it accepts `server.json`. We do
this because a release publishes the `server.json` in its tagged commit, and a
published release is immutable, so a file the registry rejects at that point
can only be fixed by shipping the next version. The schema alone doesn't catch
everything the registry refuses, and without the check a release's own publish
would be the registry's first look at the file. So the `server-json` CI job
runs `mcp-publisher validate` at the version `release.yml` pins. Because
`release.yml` runs the CI checks first, every release asks again before it
publishes.

We rejected a one-off check before the first release, because every later
release edits the file. We also rejected a check only inside `release.yml`,
because it would run for the first time during the first release, and from
then on it would fail only after the version was already tagged. The job's
download URL and SHA-256 are `release.yml`'s, and the workflow contract test
fails if they differ, so moving to a new `mcp-publisher` means editing both
workflows. The cost is 1 call to the registry per CI run, and while the
registry is down the check fails until someone re-runs it.

### Public history

The public history starts at 0.9.0, from a single squashed commit rather than
a rewritten copy of the private history I developed it in. We chose that
because a curated rewrite is too easy to get wrong, and a force-push doesn't
scrub what a host keeps on its own, such as the refs of closed pull requests.
Changes after 0.9.0 land as pull requests in this repository.

### Default port

The default port is 8627. I wanted this service to have its own default port.
I moved it off 3300 because IANA assigns 3300 to Ceph monitors (Proxmox's Ceph
integration opens it), and it sits in the 3300–3399 range SAP gateways use, so
running the container with its defaults on a Proxmox+Ceph node would collide
with the storage cluster. 8627 is unassigned in IANA's registry, and it avoids
Plex, the common media-server companion apps, Ceph's 6800–7568 OSD range,
Kubernetes' 30000–32767 NodePort range, and the crowded 3000/5000/8000/8080
development-server ports. On a phone keypad, 627 spells MCP. If you need
another, set `PORT`.

### Runtime

The server runs as emitted JavaScript. We ship it that way so an install
carries only `dist/` and the production dependencies, with no TypeScript
compiler. TypeScript is checked and compiled before the tests, the
smoke run, packaging and the Docker build. Source keeps ESM `.js` import
specifiers so Node resolves the same module graph after the build. The tests
and scripts are TypeScript too, run by Node's own type stripping with no build
step of their own, and they import the compiled `dist/` so they exercise what
ships. Type stripping checks nothing, so `npm run typecheck` runs a second
`tsc` pass over them (`test/tsconfig.json`).

### Container image

The container image is Debian slim (`node:*-slim`), not Alpine. We moved off
`node:*-alpine` because Node's musl build reliably tripped a QEMU user-mode
emulation bug when CI cross-built arm64
(`qemu: uncaught target signal 4 (Illegal instruction)`), and then the build
hung instead of failing cleanly. Debian's glibc-based Node doesn't hit that
code path, and the extra image size isn't worth optimizing back into the bug.
CI builds arm64 natively now, with no QEMU involved, but that bug is why the
image stays on Debian slim.

If you add a compose `healthcheck:`, don't have it call `wget` or `curl`. The
slim image has neither, so the probe fails every time while the server answers
normally. The image's own `HEALTHCHECK` runs `node -e` with `fetch` instead.

### Plex quirks

Paging works because the code sends container paging as HTTP headers (Plex
silently ignores the query parameters). Person, genre, collection and country
filters take names, and the code resolves them to Plex tag IDs. Studio is
matched by name instead (Plex lists a studio's ID as its name URL-encoded
twice, and the filter never matches that). An unknown library or user gets an
error that lists the valid ones.

A per-user view switches to that user's own token where Plex allows it (Home
users), because `viewCount` reflects the requesting account. Plex doesn't allow
it for friends. For them, `watch_history` is the view that works, and
`library_stats` counts each account's plays from watch history. Switching to a
Home user takes 2 steps on plex.tv (plex.tv switches the user by uuid, not
numeric id, and the server refuses the plex.tv token that comes back, so the
code trades it for the per-server access token plex.tv lists for that user).
A PIN-protected Home user is refused before any switch, with an error that
points at `watch_history`, because plex.tv switches to that user only with
their PIN. We will not take a PIN as a tool argument, because every tool
argument passes through the AI conversation and the PIN would sit in its
history.

`search` with `externalId` finds a movie or show by its IMDb, TMDB or TVDB id,
even though Plex's own `guid=` filter can't (on the current Plex agents it
matches only an item's own `plex://` guid). So the tool reads each movie and
show library with those ids attached and matches them in-process. On a server
with about 4,800 items in its video libraries, reading them all took under 2
seconds.

`play_item` puts the item in a play queue and then tells the player to play
that queue. We made this decision because Plexamp accepts a play command that
has no queue (it answers 200) and then plays nothing, so the tool would report
success for a play that never started. Plex makes a play queue only for a
request that names its client, so both playback requests carry the same
identifier `login` uses (see [Client identifier](#client-identifier)).

### Client identifier

Each machine that runs `plex-mcp login` shows up on plex.tv as its own device,
so you can tell your installs apart in Authorized Devices and remove one without
signing out the rest. The identifier plex-mcp sends is `plex-mcp-` plus a hash
of the machine's hostname and your user name. The same machine keeps it across
restarts, and no file has to hold it.

We considered one fixed identifier for every install. We rejected it because
plex.tv treats one identifier as one device. When we signed in twice under the
same identifier, plex.tv returned the same token both times and listed a single
device, and removing that device signed out both. We also considered a random
identifier saved to a file on first run. We rejected that because it needs a
writable path, the container keeps no state, and `login` writes nothing unless
you pass `--write`.

A token belongs to the device that ran `login`. If you run the container with a
token from `npx @dustinhansen/plex-mcp login`, the device is the machine you ran
that on, and 2 installs given the same token are one device. To keep 2 installs
apart, run `login` for each from a different machine or user account. The
compose and `docker run` examples set the hostname to `plex-mcp` so the
identifier the container sends stays the same when it is recreated (a
container's hostname is its container ID unless you set one).

### Cached names

Library and account names are cached for as long as the server runs. When a
name you ask for isn't in the cache, the server reads the list from Plex again
once before saying it doesn't exist. We chose this because a library added or
renamed while the container runs is exactly a name the cache doesn't have yet,
so it's found with no restart and with no extra request for a name already
known. We rejected a timed cache because it adds a clock to catch 1 more case
(a deleted library asked for by its old name), and that case already ends in a
Plex 404. The Plex Home user list from plex.tv is cached the same way, so a
call with a `user` argument doesn't wait on plex.tv each time. A Home user can
change in ways a library can't (a PIN added or removed, a user who left the
Home), so after a PIN refusal or a failed switch, the next call reads the list
again. A Home user's switched token is dropped when Plex answers 401 to it,
since a token Plex refuses (access revoked, say) would otherwise fail every
call until a restart. The next call switches again.

A Home user you put a PIN on while the server runs isn't refused until the
server reads the Home-user list again (after a restart, a name it doesn't know,
or a refused or failed switch) or Plex answers 401 to their token. Until then,
calls with their `user` argument keep working. We left this gap open because
the PIN refusal only reflects what plex.tv lets the server do. plex.tv switches
to a protected user only with their PIN, and the token the server already holds
was issued before the PIN existed. Everything that token can read, the server
owner's token can read too, so the gap shows nothing new to whoever runs the
server. We rejected re-reading the user list on a timer, since that adds the
clock we rejected for libraries above. We also rejected a re-read on every call
with a `user` argument, because it brings back the plex.tv wait the cache
exists to remove.

### Dependencies

plex-mcp has 2 runtime dependencies, `@modelcontextprotocol/sdk` and `zod`,
and no test framework. We kept it this small because a server you run next to
your media library, holding the server owner's token, should be quick to
audit. Tests run on `node:test` with an injected `fetch` standing in for Plex.

Out of scope: media mutation of any kind (see [Safety model](#safety-model)),
Plex server administration, and \*arr-stack integration.

## License

MIT. See [LICENSE](LICENSE).
