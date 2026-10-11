# Everything2MCP — HTTP console + Streamable MCP on port 8742
# Default bind is 127.0.0.1 in-app; compose sets HOST=0.0.0.0 for container networking.
# ALWAYS set EVERYTHING2MCP_HTTP_TOKEN when exposing beyond localhost.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    EVERYTHING2MCP_TRANSPORT=http \
    EVERYTHING2MCP_HTTP_HOST=0.0.0.0 \
    EVERYTHING2MCP_HTTP_PORT=8742 \
    EVERYTHING2MCP_DATA_DIR=/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/examples ./examples
COPY --from=build /app/compat ./compat

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8742

# Health endpoint is unauthenticated by design (GET /health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8742/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/index.js"]
