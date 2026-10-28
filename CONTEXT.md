# plex-mcp

An MCP server that gives an AI client a complete, safe view of one Plex Media
Server: everything in the libraries, who watched what, and a small set of
curation writes. This file is the project's glossary: the vocabulary its tools,
docs, and design conversations share.

## Language

### The tool surface

**Tool surface**:
The set of tools the server registers for a given configuration. It is curated
rather than exhaustive. Its size is a design constraint, because every tool
costs the client context.
_Avoid_: API, endpoints

**Browse & read**:
The always-registered group answering "what is in the library, and what is its
state": listing, filtering, searching, and item detail.

**Discover**:
The always-registered group answering "what should I watch": similarity, random
picks, and what is in progress.
_Avoid_: recommendations, suggestions

**History**:
The always-registered group covering who played what and when, across every
account, plus what is playing right now.
_Avoid_: analytics

**Curate**:
The write group: watched state, ratings, playlists, collections, the
watchlist, scans.
Registered unless **read-only mode** is on. Curation changes how media is
organized and marked, never the media itself.
_Avoid_: admin tools, edit tools

**Playback**:
The opt-in group that tells a client what to play. Kept apart from curate
because it is the only part of the surface that acts on the physical world.
_Avoid_: remote control, casting

**Tautulli tools**:
The optional group registered when a Tautulli instance is configured, adding
play detail and aggregate stats beyond Plex's own history.

### The safety model

**Safety model**:
The guarantees this server makes about what it can and cannot do to a Plex
server. It is a product feature, because it is what makes pointing an AI
client at a media library reasonable.

**Read**:
An operation that observes Plex state and changes nothing. Always available. No
configuration removes reads.

**Constrained write**:
A write that can only affect targets the request names. Nothing in the surface
writes to "everything matching a filter".
_Avoid_: bulk write, batch update

**Explicit ratingKey targeting**:
Naming the items a write touches by ratingKey, never by a filter or a search.
Writes acting on a whole grouping name it just as explicitly: a playlist or
collection id, a library title.

**Read-only mode**:
`PLEX_READ_ONLY=1`, which leaves curate and playback unregistered so the
surface holds only reads. It is the reverse of opt-in gating. Configuration
removes a capability instead of adding one, and it overrides the playback
opt-in.

**Opt-in gating**:
Leaving a capability unregistered until configuration enables it. A gated
capability is absent from the tool surface, not merely refused when called.
_Avoid_: feature flag, permission

**Media mutation**:
Deleting, moving, renaming, or editing a media file or its metadata. The server
performs none. Deleting a playlist or collection removes the grouping and is not
a media mutation.

**Echoed error body**:
An upstream response body, or a message read from one, passed through to the
MCP client. Plex, plex.tv and Tautulli bodies can carry server paths and
configuration, so errors here report only the status and the operation
attempted.

### Transport

**Transport**:
How an MCP client reaches this server. The choice determines the deployment
shape: one process per client, or one always-on instance.

**stdio**:
The default transport. The client launches the server as a child process and
speaks over its standard streams. No network surface.
_Avoid_: local mode, CLI mode

**Streamable HTTP**:
The network transport: one instance serving MCP over HTTP, for remote clients
and always-on deployments.
_Avoid_: SSE, web mode, REST

**Path secret**:
A high-entropy string in the MCP endpoint's URL path, acting as a capability
URL: knowing the URL is the authorization. It is the only credential on a
write-capable endpoint, so it is treated as a password.
_Avoid_: API key, token

**Install path**:
One supported way to run plex-mcp. The npm package runs it over **stdio**,
launched per client. The image runs it over **Streamable HTTP**, always on.
_Avoid_: distribution, artifact

**Registry entry**:
plex-mcp's listing in the official MCP registry. It lists each install path
as a package.
_Avoid_: listing, catalog entry

### The Plex domain

**Plex**:
The product, and by extension its HTTP API. The particular Plex Media Server an
instance is configured against is *the server*. There is one per running
instance, always one the operator owns.

**Library**:
A top-level collection of media of one type (Movies, TV Shows, Music, Photos,
Other Videos), identified by its title. Plex's own API calls this a *section*.
The project's word is library.
_Avoid_: category, folder

**Library type**:
Which of Plex's library kinds a library is, as Plex names it in the UI. It is
the field that decides how a library should be treated. The scanner or agent
configured on it is not a reliable substitute.

**Item**:
Anything in a library with a ratingKey: a movie, show, season, episode, artist,
album, track, or collection. The generic noun for "a thing you can look up,
list, rate, or add to a playlist".

**ratingKey**:
Plex's identifier for one item, and the only way this project names an item when
writing. Spelled as Plex spells it.
_Avoid_: item id, Plex id (as a name for ratingKey alone: see **Plex id**)

**Plex id**:
The identifier a tool takes for an item (its ratingKey), a playlist (its
playlist id) or a collection (its collection id). Plex gives a playlist and a
collection a ratingKey of their own, and their id is that ratingKey. Each is a
run of digits, and every tool parameter that takes one refuses anything else.
The 3 share one name because they share that one check. An account id, which a
`user` parameter takes without that check, is not a Plex id. Neither is an id
from outside Plex, such as an IMDb or TMDB id.

**Kind**:
Which sort of thing an item is: movie, show, season, episode, artist, album,
track, collection. A property of the item, distinct from library type, which is
a property of the library holding it.

**Server owner**:
The account that owns the Plex server and whose credentials this server runs
with. Every write happens as the server owner. Only reads can be taken from
another account's point of view.
_Avoid_: admin, me

**Plex Home user**:
A managed account sharing the server owner's Plex Home, with its own watched
state and its own on deck. The server owner can see the library as any Home
user who isn't PIN-protected, which is what makes per-user reads possible.
_Avoid_: profile, sub-account, child account

**Friend**:
An account the server owner shares the library with from outside their Plex
Home. Friends appear in watch history like anyone else, but the library cannot
be viewed as a friend.
_Avoid_: guest, external user

**Watched state**:
Whether an account has finished an item, its play count, and how far into it
that account is. Per-account, and what an "unwatched" filter reads.
_Avoid_: viewed flag

**Play**:
One recorded viewing or listening event, by one account, at one time.
_Avoid_: view

**Watch history**:
The list of plays on this server, across every account. It answers who watched
what and when. Watched state is what one account's plays add up to.
_Avoid_: activity log, viewing log

**Session**:
A play happening right now: an account, an item, a player, a position. Sessions
are live and transient. Plays are the durable record.
_Avoid_: stream

**On deck**:
What an account has left in progress: the next unwatched episode of each
started show, plus partially-watched movies. Plex's UI calls the same list
"Continue Watching". Both names mean this, and `continue_watching` is the tool
that reads it.
_Avoid_: up next, watchlist, resume list

**Playlist**:
An ordered, cross-library grouping of items of one media kind, video or audio.
Deleting one removes the grouping only.

**Collection**:
A named grouping of items within a single library, which Plex surfaces as a
browsable entry in that library. Deleting one removes the grouping only.
_Avoid_: set, group

**Watchlist**:
The server owner's "I want to watch this" list, kept on plex.tv rather than on
the server, so it spans every server the account uses. Its movies and shows
are matched to library items here by their Plex GUID. Writes name library
items by ratingKey. A title that is in no library here can be read on the
watchlist but not added from this server.
_Avoid_: queue, wishlist, on deck

**Extras**:
Supplementary videos attached to an item: trailers, featurettes,
behind-the-scenes, deleted scenes. Some are local files. Plex streams the
others, which have no file of their own.
_Avoid_: bonus features, specials

**Scan**:
Asking Plex to re-read a library's files from disk so it notices additions and
removals. It refreshes what Plex knows about the files. It never changes the
files or re-fetches metadata.
_Avoid_: refresh, reindex, sync

**Client**:
A Plex player app that advertises itself to the server and can be told what to
play. Distinct from an *MCP client*, the AI application talking to this server.
When both appear together, qualify each.
_Avoid_: device

**Tautulli**:
A separate self-hosted monitoring service many Plex admins already run,
recording play detail Plex itself discards. Optional here, and always
supplementary.
