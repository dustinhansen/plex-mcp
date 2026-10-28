# Running the server with Docker

The image is published to `ghcr.io/dustinhansen/plex-mcp` for `linux/amd64`
and `linux/arm64`, so any Docker host can run it without cloning or building.
Release images are tagged `:vX.Y.Z`, and `:latest` names the newest one that is
not a prerelease. This is a plain Docker Compose setup:

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
[remote-access.md](remote-access.md#publishing-the-port-beyond-this-host).

The `${VAR:?}` form makes a missing value fail the deploy loudly instead of
starting an unauthenticated container. The image carries its own
`HEALTHCHECK` against `/health`, so the service needs no `healthcheck:` block.
Put the 3 values in a `.env` next to the compose file (never in the image
or a repo):

```sh
PLEX_URL=http://<plex-host>:32400
PLEX_TOKEN=<token>                        # from `npx @dustinhansen/plex-mcp login`
MCP_PATH_SECRET=$(openssl rand -hex 32)   # the endpoint's only auth, so treat it as a password
```

Check it: `curl http://127.0.0.1:8627/health` → `ok`. The MCP endpoint is
`http://127.0.0.1:8627/<MCP_PATH_SECRET>/mcp`.

## Staying up to date

Watchtower, Diun, or your orchestrator's image-polling feature can re-pull
`:latest` automatically. Pin to a `:vX.Y.Z` tag if you'd rather choose when
to update.

## Building locally

```sh
docker build -t plex-mcp:dev .
docker run --rm --hostname plex-mcp -p 127.0.0.1:8627:8627 --env-file .env plex-mcp:dev
```

For exposing the endpoint to MCP clients beyond your LAN, see
[remote-access.md](remote-access.md).
