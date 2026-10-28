# Debian, not Alpine -- see README's "The container image is Debian, not
# Alpine" Design note. One ARG keeps both stages on the same tag.
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
# The MCP registry reads this label from the published image to confirm the
# image belongs to the server.json entry that lists it.
LABEL io.modelcontextprotocol.server.name="io.github.dustinhansen/plex-mcp"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# MCP_HOST=0.0.0.0 because a container's loopback is its own: the server has to
# listen on every interface for a published port to reach it. Where the port
# is published on the host decides who can reach it.
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HOST=0.0.0.0 PORT=8627
EXPOSE 8627
USER node
# The slim image has no wget or curl, so the probe is Node's own fetch.
# Compose files should not override it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8627)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
