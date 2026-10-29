# Remote access: connecting MCP clients to an HTTP-mode server

Applies when the server runs with `MCP_TRANSPORT=http` (for example via the
Docker image). See [docker.md](docker.md) for the container setup.

## Publishing the port beyond this host

The image listens on every interface inside the container, so the port
mapping decides who can reach it. The examples in the README and
[docker.md](docker.md) publish it on loopback (`127.0.0.1:8627:8627`), which
only the Docker host can reach. To reach the server from other machines,
publish it on every host interface instead:

```yaml
    ports:
      - "8627:8627"
```

or `-p 8627:8627` with `docker run`. That exposes the endpoint to everything on
your LAN, guarded only by the path secret (below). Restrict port 8627 with your
host's firewall if the LAN is not fully trusted. A reverse proxy needs no wider
mapping if it runs directly on the Docker host, which reaches the loopback
port, or in a container on the same Docker network, which reaches
`plex-mcp:8627` without any published port.

A server started from npm listens on `127.0.0.1` only. Set `MCP_HOST=0.0.0.0`
on it before connecting from another machine.

## Where the client connects from

Where the client runs decides which URL can work.

- **Local clients** run on your machine (desktop apps and CLIs such as Claude
  Desktop, Claude Code, Codex and Cursor), so they can use LAN URLs freely.
- **Cloud-hosted clients** connect from their vendor's servers: claude.ai
  custom connectors (on web, desktop and mobile alike) and custom MCP servers
  in ChatGPT. **A LAN URL does not work there**, whatever the certificate,
  because these clients need a public HTTPS URL. ChatGPT also offers its own
  tunnel for private servers. Its docs (linked under Option B) cover that.

Either way, the URL carries the path secret (below):
`<base URL>/<SECRET>/mcp`.

## Option A: local client (nothing exposed to the internet)

A client that speaks streamable HTTP itself can take the URL directly (see its
docs). For one that only launches stdio servers, use
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a bridge in the
client's config file. No TLS needed, nothing exposed to the internet. When the
server runs on another machine, publish its port beyond loopback first
([above](#publishing-the-port-beyond-this-host)):

```json
{
  "mcpServers": {
    "plex": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "mcp-remote", "http://<host>:8627/<SECRET>/mcp", "--allow-http"]
    }
  }
}
```

Use an absolute `npx` path for a desktop app: one launched from the GUI
doesn't inherit your shell's PATH. Claude Desktop also reads its config only at
launch, so fully quit and relaunch it after editing.

## Option B: public HTTPS (works for local and cloud-hosted clients)

Put any TLS-terminating reverse proxy or tunnel in front of the server's port
**8627**, so that a public hostname with a valid certificate forwards to
`http://<host>:8627`. A proxy on another machine needs the port published
beyond loopback ([above](#publishing-the-port-beyond-this-host)). The proxy
must serve on port **443**. I've seen a claude.ai connector pointed at a
non-standard HTTPS port fail to connect while the endpoint was publicly
reachable.

Then add the URL to your client. It ends in `/mcp`. A stdio-only client
reaches it through the Option A bridge:

```
https://<your-host>/<SECRET>/mcp
```

The secret travels in the URL, so the client needs no other authentication.
Leave OAuth unset, or choose the no-authentication option where the client
offers one. Each vendor's docs say where custom servers are added:
[claude.ai](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

Keeping an Option A entry alongside this is reasonable in a client that has
both: it shows up as a duplicate `plex` tool set, but keeps working if the
public route breaks.

## The path secret

The endpoint's only auth is a long random path segment (a capability URL)
that only you know. A cloud-hosted client's vendor knows it too, once you add
the URL there. Set it as `MCP_PATH_SECRET` in the server's environment. In
http mode the server **refuses to start without one**. It also refuses one
shorter than 16 characters or holding anything but letters, digits, `-`, `_`,
`.` and `~`. The server accepts any path that contains the secret, so a secret
of `1` would match every path with a 1 in it. Other characters can be encoded
or cut off on the way to the server, and a secret holding a space, `?` or `#`
would never match at all.

```sh
openssl rand -hex 32
```

The secret is enforced in-process, so it is required on every route to the
server, a LAN reverse proxy included: with a secret set, bare `/mcp` returns
404, not a connection error. Some proxies strip the mount path and others
forward it verbatim, so the server accepts the secret anywhere in the request
path rather than expecting an exact route. It still **must** appear in the
path the server receives. If your proxy mounts the endpoint under
`/<SECRET>` and strips that prefix, put the secret back on the upstream
target (`http://<host>:8627/<SECRET>`), or the server sees bare `/mcp` and
returns 404.

## Rotating the secret

Rotate it any time, and right away if the URL ever leaks, because it is the
only auth on an endpoint with write tools.

1. Generate a new value with `openssl rand -hex 32`, set it as
   `MCP_PATH_SECRET` (in the compose `.env`, for the Docker setup), and
   recreate the container.
2. If your proxy routes on the secret path, update that route to the new
   value.
3. Update the URL in each client.

## Security notes

- The secret path is the **only** auth. Anything that can reach the endpoint
  with it can read your library and make writes: mark watched, rate, edit
  playlists and collections. In http mode the server refuses to start without
  `MCP_PATH_SECRET` (override with `MCP_ALLOW_NO_AUTH=1` only when the
  listener is unreachable from untrusted networks).
- **Any reverse proxy that forwards all paths publishes every path**,
  including bare `/mcp`. That is why the secret is enforced in-process rather
  than left to the proxy: a proxy rule pointed at port 8627 forwards `/mcp`
  verbatim, and without the in-process check that path would be open on any
  publicly resolvable hostname.
- A public endpoint is **on the internet** and the secret path is the only
  gate. Its hostname is discoverable (certificate authorities log it in
  Certificate Transparency), so treat the secret like a password: don't
  commit it, and rotate it if a client ever leaks the URL.
- A LAN-only listener is still exposed to everything on that LAN. See the
  firewall note under
  [Publishing the port beyond this host](#publishing-the-port-beyond-this-host).
- Your Plex token lives only in your compose file (or `.env`) on the host,
  never in the image or this repo.
