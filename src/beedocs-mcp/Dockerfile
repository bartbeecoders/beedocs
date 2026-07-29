# BeeDocs MCP server — Streamable HTTP transport.
#
# Deployed as a sidecar next to the API container (same pod), so it reaches
# BeeDocs over the pod loopback at http://localhost:8080. Build context is this
# directory: podman build -f src/beedocs-mcp/Dockerfile src/beedocs-mcp

# --- Build ---
FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# --- Prune to production deps ---
FROM node:22-bookworm AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# --- Runtime ---
FROM node:22-bookworm-slim AS final
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=5090 \
    MCP_HTTP_HOST=0.0.0.0
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Nothing is written to disk, so there is no volume to own — run unprivileged.
USER node
EXPOSE 5090
ENTRYPOINT ["node", "dist/index.js"]
