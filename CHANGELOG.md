# Changelog

## 0.9.1-rc.1 — 2026-10-29

- npm versions are now staged when a release is published, and go live
  once I approve them. Nothing about how the server behaves changes with
  this.
- In http mode with `MCP_PATH_SECRET` set, the startup line names the
  endpoint as `/<MCP_PATH_SECRET>/mcp`. It used to name `/mcp`, which
  answers 404 whenever a secret is set. The secret's value stays out of the
  log.

## 0.9.0 — 2026-10-28

Initial public release.

- Full-library browsing with watched state on every record, all-user watch
  history, person credits, library stats and change feeds. A blank tag filter
  (`genre`, `collection`, `country` or `studio`) or `person_credits` `name`
  fails with an error naming the parameter, and nothing is sent to Plex.
- `library_changes` takes every `kind` but `collection`, because the listing
  it reads holds no collections. `list_media` with `kind: "collection"` lists
  a library's collections.
- `list_media` and `random_pick` filter on when an item was last watched:
  `lastViewedBefore` and `lastViewedAfter` take an ISO date or a relative
  value like `-3y`. Plex counts a never-watched item as last viewed before
  any date, so `watched: "watched"` with `lastViewedBefore` leaves those out.
- `search` takes `externalId` (`imdb:`, `tmdb:` or `tvdb:`) to look a movie
  or show up by the id Plex already holds for it.
- Discovery: `similar_items`, `random_pick` and `continue_watching`, the
  prompts `movie_night` and `whats_new`, and the resource `plex://libraries`.
  `continue_watching` reports how far into each item you are, or full item
  records with `detail: true`.
- `plex-mcp login` (plex.tv PIN sign-in) and per-Plex-Home-user views. Each
  machine that runs `login` is its own device on plex.tv, identified by
  `plex-mcp-` plus a hash of its hostname and user name.
  On macOS and Linux, a new file that `login --write` creates is readable
  by its owner only, and an existing one keeps its mode.
  A PIN-protected Home user is refused before plex.tv is asked to switch,
  and the error points at `watch_history`. Calls that view the library as
  the same Home user at the same time share one switch.
  `random_pick` takes the same `user` as `list_media`, so its watched
  filter reads that Home user's watched state.
- A library, account or Plex Home user added or renamed while the server
  runs is found without a restart: a name missing from the cached list reads
  the list again once before the call fails. Libraries and accounts are read
  from Plex, and the Home-user list from plex.tv. A Home user whose token
  Plex answers with 401 is switched again on the next call.
- Curation writes: playlists, collections, watched state, ratings, scans.
  Every write names its targets, and `manage_collection` `create` names the
  library the collection goes in. When `kind` is left out, it comes from
  that library: movie, show, or album for a music library. A `kind`
  that contradicts the library, or a library type with no collection kind,
  is refused before anything is written. If Plex fails partway through
  `set_watched`, the error names the keys already marked. A playlist or
  collection `remove_items` that fails partway names the keys already
  removed. `manage_playlist` `remove_items` lists under `skipped` any matched
  item Plex returns without its playlist item id, since there is no id to
  delete it by. A playlist or collection `create` or `add_items` is refused
  before anything is written when the server reports no machine identifier.
- The server owner's plex.tv watchlist: `get_watchlist` lists it and says
  which titles are in a library here, and `manage_watchlist` adds or removes
  library movies and shows by ratingKey. Every key is checked before plex.tv
  is called, so one unknown key fails the call and nothing is sent. If
  plex.tv fails partway, the error names the keys already changed.
- Opt-in playback (`PLEX_ALLOW_PLAYBACK=1`) and optional Tautulli tools.
  `play_item` puts the item in a play queue and plays that on the player,
  and refuses an item it cannot queue, such as a playlist.
  The Tautulli tools need Tautulli 2.18.0 or later, because the API key goes
  in the `X-Api-Key` header and never in the request URL.
- `PLEX_READ_ONLY=1` registers no write or playback tools, whatever
  `PLEX_ALLOW_PLAYBACK` says. The startup line reports the smaller count.
- Every tool has a `title` and all four MCP annotations: `readOnlyHint` is
  true for the reads, `destructiveHint` only for `manage_playlist` and
  `manage_collection`, and `openWorldHint` is false throughout.
- stdio and streamable-HTTP transports, MCP protocol revision 2025-11-25.
  HTTP listens on `127.0.0.1:8627` by default. `MCP_HOST` and `PORT`
  override it, and the container image sets `MCP_HOST=0.0.0.0`. HTTP mode
  answers 403 to a browser `Origin` that is not loopback, the specific address
  `MCP_HOST` names, or `null`. It answers 400 to a request line whose target
  it cannot parse, such as `GET //[::1`, and keeps serving. A request body
  over 1 MiB gets a 413 once the client has sent all of it, and the
  connection stays usable for the next request. Past 8 MiB it drops the
  connection without answering. A server error after start-up, such as
  `EMFILE` when the process runs out of file descriptors, is logged as 1 line
  on stderr and does not stop the server.
  On SIGTERM or SIGINT, HTTP mode stops accepting connections, finishes the
  requests it already has and exits 0, so `docker stop` returns at once
  instead of waiting out its kill timer. If those requests take more than 5
  seconds, it exits 1 and cuts them off.
- A tool call whose arguments hold more than 1000 array elements and object
  members combined is refused with a tool error before its arguments are
  validated, on either transport, so a request under the body cap can't
  exhaust memory during validation. The longest ratingKeys list any tool takes
  is 500.
- Startup refuses a bad setting with 1 line on stderr and exit code 1:
  a `PLEX_URL` or `TAUTULLI_URL` that is not an `http` or `https` URL,
  `MCP_TRANSPORT` other than `stdio` or `http`, `PORT` that is not an integer
  from 0 to 65535, an HTTP address it cannot listen on (the line names
  the address and the cause, such as `EADDRINUSE`), and an `MCP_PATH_SECRET`
  shorter than 16 characters or holding anything but letters, digits, `-`,
  `_`, `.` and `~` (the line leaves the value out). An empty `PORT` means
  8627, as an unset one does. `TAUTULLI_URL` or `TAUTULLI_API_KEY` set
  without the other is refused the same way, since one alone would leave the
  Tautulli tools unregistered without a word on stderr.
- The npm package `@dustinhansen/plex-mcp` needs Node 22 or later. It ships
  the compiled `dist/` runtime, not the TypeScript sources. It is a CLI,
  not a library: it has a `bin` and no `main`, so `import`ing it fails
  rather than starting a server.
- The container image `ghcr.io/dustinhansen/plex-mcp` is built for
  `linux/amd64` and `linux/arm64`. It declares a `HEALTHCHECK` that probes
  `/health` with Node's `fetch`. Don't override it with a `wget` or `curl`
  check, since the slim base image has neither.
- Every release publishes an exact `:vX.Y.Z` image tag. `:latest` moves only
  on a release that is not a prerelease.
- Each platform image carries the OCI labels `org.opencontainers.image.revision`,
  `.source` and `.version`. `docker inspect` reads the commit an image was
  built from, once it is pulled:
  ```sh
  docker pull ghcr.io/dustinhansen/plex-mcp:v0.9.0
  docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/dustinhansen/plex-mcp:v0.9.0
  ```
- The npm package is published with provenance, and the image carries a
  build provenance attestation that `gh attestation verify` checks.
- The MCP registry entry `io.github.dustinhansen/plex-mcp` lists both install
  paths: the npm package over stdio, and the image over streamable HTTP. The
  image's entry publishes the port on `127.0.0.1` only and puts
  `MCP_PATH_SECRET` in the endpoint URL.
