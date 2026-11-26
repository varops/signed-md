# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# ---- Build: install production dependencies and fetch Typst ----
# The full node image already has python3, make, g++, curl and xz for native modules.
FROM node:${NODE_VERSION} AS build
RUN corepack enable

ARG TYPST_VERSION=0.13.1
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac \
 && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${arch}-unknown-linux-musl.tar.xz" | tar -xJ -C /tmp \
 && mv /tmp/typst-*/typst /usr/local/bin/typst \
 && typst --version

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/verify/package.json packages/verify/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter "@signed-md/server..." \
 # Keep only the compiled SQLite addon; drop its sources and build intermediates.
 && cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
 && rm -rf deps src build/Release/obj build/Release/obj.target build/Release/.deps build/deps
COPY packages ./packages
COPY apps/server/src ./apps/server/src
COPY apps/server/assets ./apps/server/assets
COPY brand ./brand
COPY skills ./skills

# ---- Bundle: the server in a few files instead of ~700 modules, so a container starts faster ----
FROM node:${NODE_VERSION} AS bundle
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/verify/package.json packages/verify/
COPY apps/server/package.json apps/server/
# Native addons stay external, so nothing needs compiling here.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@signed-md/server..."
COPY packages ./packages
COPY apps/server/src ./apps/server/src
COPY apps/server/scripts ./apps/server/scripts
RUN node apps/server/scripts/bundle.mjs

# ---- Runtime ----
FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    TYPST_BIN=/usr/local/bin/typst
WORKDIR /app
COPY --from=build /usr/local/bin/typst /usr/local/bin/typst
COPY --from=build /app /app
COPY --from=bundle /app/apps/server/bundle /app/apps/server/bundle
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The bundled server. The CLI still runs from source: node apps/server/src/cli.ts
CMD ["node", "apps/server/bundle/main.js"]
