# Stages:
#   deps        every workspace's dependencies from the root lockfile
#   check       full source + generated Prisma client; `make check` runs lint, typecheck, tests, build in it
#   client-build / server-build   production artefacts
#   production  what ships: linux/amd64 image, non-root app, tini as PID 1, migrations before start
FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci

FROM deps AS check
COPY client ./client
COPY server ./server
COPY docs ./docs
COPY contracts ./contracts
RUN npm run db:generate --workspace=server
CMD ["npm", "run", "check:all"]

FROM check AS client-build
# The prod bundle is static: the API and the socket are same-origin.
ENV VITE_API_URL=/api
RUN npm run build --workspace=client

FROM check AS server-build
RUN npm run build --workspace=server

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false

FROM base AS production
# The heap is capped well below the 900 MB container limit (headroom for buffers, native memory and the
# PDF export), so V8 collects before the kernel would kill the process.
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=640
RUN apk add --no-cache tini su-exec
COPY --from=prod-deps    /app/node_modules          ./node_modules
COPY --from=server-build /app/server/dist           ./dist
COPY --from=server-build /app/server/prisma         ./prisma
COPY --from=server-build /app/server/prisma.config.ts ./prisma.config.ts
COPY --from=server-build /app/server/generated      ./generated
COPY --from=server-build /app/server/assets         ./assets
COPY --from=server-build /app/server/package.json   ./package.json
COPY --from=client-build /app/client/dist           ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/uploads && chown node:node /app/uploads

EXPOSE 4002
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4002/api/ready >/dev/null || exit 1
# The entrypoint starts as root only to fix ownership of the uploads volume, then drops to `node`.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
