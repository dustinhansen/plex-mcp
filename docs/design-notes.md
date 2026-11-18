# Design notes

The reasons behind plex-mcp's tool surface, safety rules, release process and
Plex workarounds. Each note says what I decided, why, and what I rejected. The
[README](../README.md) covers what the server does and how to run it.

## Limited surface area

plex-mcp registers a small set of tools rather than covering the whole Plex
API. I made this decision because every registered tool costs your MCP client
context before a single call is made, and a model does better with a set it can
hold in context. I try new capability first as a parameter on an existing
tool. You'll see that `list_media` carries the filters a dozen per-kind tools
would otherwise have spread out. The same rule gives each Plex list 1 tool.
`continue_watching` reads the on-deck list, and I named it for the Continue
Watching row you see in Plex's UI. Its `detail` parameter returns the full item
records, so a second tool for the same list would add nothing. So if Plex can
do something the tools don't expose, that's something I left out on purpose.

But I'm open to adding more surface in the future. Please open a
[feature request issue](https://github.com/dustinhansen/plex-mcp/issues/new?template=feature_request.yml)
and tell me what you'd use it for, because the use is what tells me which
existing tool could take it as a parameter. I take requests in the issue
tracker rather than GitHub Discussions, since that's the one place I triage.

## Tautulli

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

The API key travels in the `X-Api-Key` header and never in the request URL. I
made this decision because a URL lands in the logs of any proxy between
plex-mcp and Tautulli, and in Tautulli's own access log, while a header
usually does not. Tautulli's API reference prefers the header for the same
reason. Tautulli reads the header from 2.18.0 on, so that version is the
minimum. If you run an older Tautulli, every call fails with a missing-key
error (HTTP 400), and the error tells you to check the version first. I
rejected keeping the key in the URL and saying so, because that documents the
exposure instead of removing it. I also rejected trying the header first and
falling back to the URL, because the fallback could not tell an older Tautulli
from a wrong key or a bad request, and each time it ran it would put the key
back in the URL.

## Watchlist

The watchlist takes library items only. I made this decision because any
write that picks its target from search results breaks the rule that every
write names its targets. You'll see that `manage_watchlist` names items by
ratingKey like every other write, and a title in no library here has no
ratingKey (adding one would need a plex.tv Discover search by title).
`get_watchlist` still shows those titles, with `ratingKey` null.

The list itself lives on plex.tv, not on your server. It sits with the
curation writes anyway, because it's the server owner's "I want to watch this"
list.

## Remote access

Remote access works by capability URL, and the server checks the secret
itself. I put the check in-process because any reverse proxy that forwards
all paths publishes every path, bare `/mcp` included. The path secret in the
endpoint's URL authorizes every request. The default transport, stdio, has no
network surface at all. HTTP mode is streamable HTTP (not the deprecated SSE
transport) and stateless (every request builds a fresh server, and all real
state lives in Plex). See [remote-access.md](remote-access.md).

HTTP mode follows the transport's 2 local-safety rules. It listens on loopback
unless `MCP_HOST` says otherwise, and it answers 403 to a browser `Origin` that
isn't loopback, the specific address `MCP_HOST` names, or `null`. A wildcard
`MCP_HOST` such as the image's `0.0.0.0` names no address. The check stops DNS
rebinding (a rebound page's `Origin` names the attacker's domain), and it runs
before the path secret is checked. I rejected matching the request's `Host`
header instead, because a rebound request's `Host` names the same domain and
would get through. A `null` origin, sent by local files and sandboxed pages,
passes. The server sends no CORS headers, so such a page can't read the
response, and it still needs the secret. There is no allowed-origins setting.
The clients in [remote-access.md](remote-access.md) are not browser
pages and send no `Origin`, so if you host a browser client on some other
domain, it's refused.

The listen address is `MCP_HOST`, not the generic `HOST`. I named it that
because a shell or CI environment may export `HOST` for its own reasons, and an
inherited `HOST=0.0.0.0` would silently move the bind address off loopback. So
the server ignores `HOST`. I kept `PORT` under its plain name because an
inherited port can make the server unreachable, but it can't move it off
loopback.

## Optional spec features

I left a few optional MCP spec features out on purpose. No tool declares an
`outputSchema`, because claude.ai drops any tool whose output schema carries
the draft-07 `$schema` stamp the SDK adds. I found that on another MCP server
of mine. There are no sessions, because HTTP mode is stateless (above). There
is no per-tool rate limiting either. Over stdio there is 1 client and nothing
to limit, and over HTTP the path secret and the 1 MiB request-body cap are the
mitigations. On either transport, one tool call may carry at most 1000 array
elements and object members combined (twice the longest ratingKeys list any
tool takes), so a request under the body cap can't exhaust memory while its
arguments are checked.

But I'm open to adding these in the future. If your client needs one, please
open a
[feature request issue](https://github.com/dustinhansen/plex-mcp/issues/new?template=feature_request.yml)
and say what it would let you do.

## Releases

Everything I publish comes from a release, never from `main`. I set it up
that way so the npm package and the image you install can each be traced back
to the tagged commit that built it (both carry build provenance). A GitHub
release, published by hand, is the only trigger for `release.yml`, which
stages the npm package and publishes the image and the registry entry.

The workflow can only stage an npm version, and it goes live once I approve it
on npm with 2FA. I set it up this way so that a compromised workflow, action
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

## Registry entry

The registry entry lists the image beside the npm package. I list both
because an npm-only entry would hide the always-on HTTP server from anyone who
finds plex-mcp through the official MCP registry (the npm package runs over
stdio, 1 process per client). The image's entry describes the safe local
default: the port published on loopback only, and the path secret in the
endpoint URL. If you want LAN or remote exposure,
[remote-access.md](remote-access.md) covers it. The image carries
the `io.modelcontextprotocol.server.name` label the registry's package docs ask
for as proof of ownership, and a test keeps that label, `server.json`, and
`package.json`'s `mcpName` and version in step.

## Published port

Every copy-paste example in the README publishes the port on loopback only. I
made this decision because people copy from the README, so whatever the
examples publish becomes the default without anyone choosing it. The compose
and `docker run` examples in the README and in [docker.md](docker.md) publish
`127.0.0.1:8627:8627`, the same mapping as the registry entry, and a test keeps
all 3 in step. (The image sets `MCP_HOST=0.0.0.0`, since a container that
listens on its own loopback is unreachable through any port mapping, so the
mapping alone decides who can reach the server.)

I rejected keeping `8627:8627` in the examples and rewording the registry
note to say they expose the port to the LAN. The path secret still guards a
LAN-wide port. But the README would then describe a different safe default
from the registry entry's.

## Registry validation

Every pull request asks the registry whether it accepts `server.json`. I do
this because a release publishes the `server.json` in its tagged commit, and a
published release is immutable, so a file the registry rejects at that point
can only be fixed by shipping the next version. The schema alone doesn't catch
everything the registry refuses, and without the check a release's own publish
would be the registry's first look at the file. So the `server-json` CI job
runs `mcp-publisher validate` at the version `release.yml` pins. Because
`release.yml` runs the CI checks first, every release asks again before it
publishes.

I rejected a one-off check before the first release, because every later
release edits the file. I also rejected a check only inside `release.yml`,
because it would run for the first time during the first release, and from
then on it would fail only after the version was already tagged. The job's
download URL and SHA-256 are `release.yml`'s, and the workflow contract test
fails if they differ, so moving to a new `mcp-publisher` means editing both
workflows. The cost is 1 call to the registry per CI run, and while the
registry is down the check fails until someone re-runs it.

## Public history

The public history starts at 0.9.0, from a single squashed commit rather than
a rewritten copy of the private history I developed it in. I chose that
because a curated rewrite is too easy to get wrong, and a force-push doesn't
scrub what a host keeps on its own, such as the refs of closed pull requests.
Changes after 0.9.0 land as pull requests in this repository.

## Secret scanning

GitHub's secret scanning with push protection is the gate for secrets here,
so a push carrying a known token shape is blocked before it reaches the
repository. gitleaks is a check I run by hand before a release, and it has no
CI job. I made this decision because a CI job would mostly look for the same
token shapes push protection already blocks. The main thing gitleaks adds is
its `generic-api-key` rule, and in this repository's history that rule has only
flagged a test fixture. `.gitleaks.toml` allows that one fixture (the path
secret in `test/server.test.ts`, matched by rule, file and value) and keeps
every default rule, so `gitleaks git .` and `gitleaks dir .` both report no
leaks. Treat any finding as real until you've checked it.

## Default port

The default port is 8627. I wanted this service to have its own default port.
I moved it off 3300 because IANA assigns 3300 to Ceph monitors (Proxmox's Ceph
integration opens it), and it sits in the 3300–3399 range SAP gateways use, so
running the container with its defaults on a Proxmox+Ceph node would collide
with the storage cluster. 8627 is unassigned in IANA's registry, and it avoids
Plex, the common media-server companion apps, Ceph's 6800–7568 OSD range,
Kubernetes' 30000–32767 NodePort range, and the crowded 3000/5000/8000/8080
development-server ports. On a phone keypad, 627 spells MCP. If you need
another, set `PORT`.

## Runtime

The server runs as emitted JavaScript. I ship it that way so an install
carries only `dist/` and the production dependencies, with no TypeScript
compiler. TypeScript is checked and compiled before the tests, the
smoke run, packaging and the Docker build. Source keeps ESM `.js` import
specifiers so Node resolves the same module graph after the build. The tests
and scripts are TypeScript too, run by Node's own type stripping with no build
step of their own, and they import the compiled `dist/` so they exercise what
ships. Type stripping checks nothing, so `npm run typecheck` runs a second
`tsc` pass over them (`test/tsconfig.json`).

## Container image

The container image is Debian slim (`node:*-slim`), not Alpine. I moved off
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

## Plex quirks

Paging works because the code sends container paging as HTTP headers (Plex
silently ignores the query parameters). Person, genre, collection, country and
label filters take names, and the code resolves them to Plex tag IDs. Studio is
matched by name instead (Plex lists a studio's ID as its name URL-encoded
twice, and the filter never matches that). An unknown library or user gets an
error that lists the valid ones.

If you filter on a `label` used only in another library, you get no items (Plex
lists every label on the server under every library). A `label` that no library
has gets the same error as an unknown genre.

`get_children` can take 2 requests, because Plex has 2 paths to a collection's
members and neither one always answers. The metadata path
(`/library/metadata/<ratingKey>/children`) returns nothing for an episode
collection and for most smart collections. The collections path
(`/library/collections/<ratingKey>/children`) returns nothing for a smart
collection whose saved query names a different server. So the code reads the
metadata path first and tries the collections path only when that comes back
empty, which means an empty show or album takes 2 requests as well. I rejected
reading the collections path alone because it misses those smart collections and
answers 404 for shows, seasons, artists and albums. I also rejected looking up
the item's kind first, because that adds a request to every call and still needs
the fallback. A `collection` parameter is out too, because anyone who left it off
would get a silent 0.

Plex answers the metadata path with a 400 for a movie, an episode or a track. So
the code reads a 400 there as an item with no children and says so, which tells
you to stop rather than retry. An unknown ratingKey and a playlist's ratingKey
without `playlist: true` get a 404 instead. I leave that as Plex's 404, because
"no children" would be wrong for both.

A `collection` filter with no `kind` lists the kind the collection holds (the
collection's `subtype` in Plex). A TV library's collection can hold episodes, and
a listing at the library's top-level kind would read as empty, so `list_media`
and `random_pick` read the subtype first. That adds a read of the library's
collections, and only on a call that names a collection and no kind. If you pass
`kind`, it's sent as given. If the collection holds something the tool has no
kind for, or Plex lists no collection by that title, the call uses the kind it
would with no collection at all, since a listing has to filter on some kind. I
rejected retrying at another kind after 0 results because a retry can't tell the
wrong kind from a filter that really matched nothing. I also rejected a note on
the empty result because it still leaves you making a second call for an answer
the server already has. Requiring `kind` with `collection` would break every
movie call that works today, so I rejected that too.

If you name a smart collection in the `collection` filter of `list_media` or
`random_pick` and it has no tag, you get an error naming its ratingKey and
`get_children`. The filter is a Plex tag query and most smart collections have
no tag. Without this check, you'd get `No collection`, or the name would fall
back to a longer tag and list a different collection's members. The check adds a
read of the library's collections, and only when no tag matches the name
exactly. A smart collection that does have an exact tag lists as usual. I left
that alone because the 3 I checked list the same total as their `childCount`. I
rejected listing a smart collection's members in `list_media` because the filter
would stop being a Plex query, so every other filter and sort would need its own
handling, for
something `get_children` already does. I rejected only documenting it because
`No collection` would stay false and the wrong members would stay too.

A per-user view switches to that user's own token where Plex allows it (Home
users), because `viewCount` reflects the requesting account. Plex doesn't allow
it for friends. For them, `watch_history` is the view that works, and
`library_stats` counts each account's plays from watch history. Switching to a
Home user takes 2 steps on plex.tv (plex.tv switches the user by uuid, not
numeric id, and the server refuses the plex.tv token that comes back, so the
code trades it for the per-server access token plex.tv lists for that user).
A PIN-protected Home user is refused before any switch, with an error that
points at `watch_history`, because plex.tv switches to that user only with
their PIN. I will not take a PIN as a tool argument, because every tool
argument passes through the AI conversation and the PIN would sit in its
history.

`search` with `externalId` finds a movie or show by its IMDb, TMDB or TVDB id,
even though Plex's own `guid=` filter can't (on the current Plex agents it
matches only an item's own `plex://` guid). So the tool reads each movie and
show library with those ids attached and matches them in-process. On a server
with about 4,800 items in its video libraries, reading them all took under 2
seconds.

`play_item` puts the item in a play queue and then tells the player to play
that queue. I made this decision because Plexamp accepts a play command that
has no queue (it answers 200) and then plays nothing, so the tool would report
success for a play that never started. Plex makes a play queue only for a
request that names its client, so both playback requests carry the same
identifier `login` uses (see [Client identifier](#client-identifier)).

## Client identifier

Each machine that runs `plex-mcp login` shows up on plex.tv as its own device,
so you can tell your installs apart in Authorized Devices and remove one without
signing out the rest. The identifier plex-mcp sends is `plex-mcp-` plus a hash
of the machine's hostname and your user name. The same machine keeps it across
restarts, and no file has to hold it.

I considered one fixed identifier for every install. I rejected it because
plex.tv treats one identifier as one device. When I signed in twice under the
same identifier, plex.tv returned the same token both times and listed a single
device, and removing that device signed out both. I also considered a random
identifier saved to a file on first run. I rejected that because it needs a
writable path, the container keeps no state, and `login` writes nothing unless
you pass `--write`.

A token belongs to the device that ran `login`. If you run the container with a
token from `npx @dustinhansen/plex-mcp login`, the device is the machine you ran
that on, and 2 installs given the same token are one device. To keep 2 installs
apart, run `login` for each from a different machine or user account. The
compose and `docker run` examples set the hostname to `plex-mcp` so the
identifier the container sends stays the same when it is recreated (a
container's hostname is its container ID unless you set one).

## Cached names

Library and account names are cached for as long as the server runs. When a
name you ask for isn't in the cache, the server reads the list from Plex again
once before saying it doesn't exist. I chose this because a library added or
renamed while the container runs is exactly a name the cache doesn't have yet,
so it's found with no restart and with no extra request for a name already
known. I rejected a timed cache because it adds a clock to catch 1 more case
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
calls with their `user` argument keep working. I left this gap open because
the PIN refusal only reflects what plex.tv lets the server do. plex.tv switches
to a protected user only with their PIN, and the token the server already holds
was issued before the PIN existed. Everything that token can read, the server
owner's token can read too, so the gap shows nothing new to whoever runs the
server. I rejected re-reading the user list on a timer, since that adds the
clock I rejected for libraries above. I also rejected a re-read on every call
with a `user` argument, because it brings back the plex.tv wait the cache
exists to remove.

## Dependencies

plex-mcp has 2 runtime dependencies, `@modelcontextprotocol/sdk` and `zod`,
and no test framework. I kept it this small because a server you run next to
your media library, holding the server owner's token, should be quick to
audit. Tests run on `node:test` with an injected `fetch` standing in for Plex.

Out of scope: media mutation of any kind (see [Safety model](../README.md#safety-model))
and Plex server administration.
