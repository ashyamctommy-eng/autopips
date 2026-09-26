# syntax=docker/dockerfile:1.7
###############################################################################
# Autopipsz — autopips.pro
# Next.js 14 (App Router) WEB image.
#
#   docker build -t autopipsz/web:$(git rev-parse --short HEAD) .
#   docker run --rm -p 127.0.0.1:3000:3000 --env-file .env autopipsz/web:latest
#
# This image runs ONLY the Next.js process (`npm start` → `next start`, port
# 3000). The Socket.IO + bot runtime is a *separate* process with a *separate*
# image — see `Dockerfile.worker`. The web process never serves the WebSocket
# upgrade; that is the reverse proxy's job (see deploy/nginx/autopips.pro.conf).
#
# BASE IMAGE — node:20-alpine, and why it works for this repo:
#   * `@node-rs/argon2` (password hashing) is a napi-rs package, not a
#     node-gyp build: it ships prebuilt musl binaries
#     (`@node-rs/argon2-linux-x64-musl` as an optional dependency), so no
#     compiler toolchain is needed on Alpine.
#   * Prisma ships `linux-musl-openssl-3.0.x` query engines; `npx prisma generate`
#     is run *inside* this image, so the client is generated for the musl target
#     it will actually run on. `openssl` is installed below because Prisma's
#     engine detection needs libssl present.
#   * `ioredis` and `socket.io` are pure JS.
#   Fallback: if a future dependency starts failing on musl, switch `base` to
#   `node:20-bookworm-slim` (glibc) and replace the `apk add` lines with
#   `apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates`.
#
# BUILD SECRETS — READ THIS BEFORE ADDING AN ARG
#   Only `NEXT_PUBLIC_*` values may be passed as build arguments. Everything
#   passed with `--build-arg` is recorded verbatim in the image history
#   (`docker history`) and in the build cache, i.e. it is PUBLISHED, not secret.
#   No other variable from .env.example may ever be passed as a build arg.
#   Every secret (JWT_SECRET, DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY,
#   NOWPAYMENTS_*, WS_INTERNAL_TOKEN) is injected at
#   RUNTIME via `--env-file` / compose `env_file:` and is validated by
#   `src/lib/env.ts`, which exits the process when anything is missing.
#   The build needs no secret at all: every page is rendered dynamically
#   (`export const dynamic = 'force-dynamic'`), so `next build` performs no
#   database or broker access.
#
# NO `output: 'standalone'`
#   Standalone mode would require adding `output: 'standalone'` to
#   `next.config.mjs`. That file is owned by another team, so this image uses a
#   conventional build (`next build`) plus `npm start`, with a pruned
#   `node_modules` in the runtime stage.
###############################################################################

# ---------------------------------------------------------------- base ------
FROM node:20-alpine AS base
# libc6-compat: glibc shims for prebuilt native addons. openssl: Prisma engines.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- deps ------
# Full install, dev dependencies included: `next build` needs typescript,
# tailwindcss, postcss and eslint-config-next, and `prisma generate` needs the
# `prisma` CLI (a devDependency) plus the schema.
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma
RUN npm ci

# ------------------------------------------------------------- builder ------
FROM base AS builder
ENV NODE_ENV=production

# NEXT_PUBLIC_* only. Anything else here would be baked into image history —
# see the header comment. `NEXT_PUBLIC_APP_URL` is public metadata (the site
# canonical URL); it is also inlined into the client bundle by Next.js.
# `NEXT_PUBLIC_WS_URL` is deliberately EMPTY: with it unset, `src/lib/socket-client.ts`
# connects to the SAME ORIGIN on path `/ws/socket.io`, and the reverse proxy
# routes `/ws/*` to the worker (with the WebSocket upgrade). Set it only when the
# socket runtime lives on a different hostname than the page (e.g. separate
# edge deployment) — and then it must be a public URL, never a secret.
ARG NEXT_PUBLIC_APP_URL=https://autopips.pro
ARG NEXT_PUBLIC_WS_URL=
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma client for the musl target of THIS image. `npm run build` also runs
# `prisma generate` (see package.json); doing it explicitly first keeps the
# failure mode obvious and makes the generated client available to any
# type-check step.
RUN npx prisma generate
RUN npm run build

# -------------------------------------------------------------- runner ------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# dumb-init: the container's PID 1 must forward SIGTERM/SIGINT to `next start`
# so `docker stop` is a graceful shutdown instead of a 10s SIGKILL.
RUN apk add --no-cache dumb-init

# Runtime dependencies only. The full tree is copied first, then pruned (the
# lockfile is copied alongside it because `npm prune` reconciles node_modules
# against package.json + the lockfile); the generated Prisma client
# (`node_modules/.prisma`) and the `@prisma/*` runtime packages are re-copied
# afterwards because they are build output, not package manager state, and must
# survive the prune no matter how npm classifies them.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/package-lock.json ./package-lock.json
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma

# The Prisma CLI is a devDependency, so the prune above removes it — but the
# container applies migrations on boot (`prisma migrate deploy` in the start
# command, see railway.toml). Re-add it here so this image is self-sufficient
# and needs no separate migration service. It is only the CLI; the generated
# client and its engines came from `deps` and are untouched.
RUN npm install --no-save --no-audit --no-fund prisma@5.22.0 \
 && npm cache clean --force

COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs
# The schema is not needed to *run* a generated client, but keeping it makes the
# image self-describing for `prisma migrate deploy` debugging on the host.
COPY --from=builder /app/prisma ./prisma
# Migration gate + one-time admin bootstrap. `--chown=node:node` because the
# runner drops to the unprivileged `node` user and both must be executable/readable
# there. The Prisma CLI these need is installed above (see the npm install).
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
COPY --chown=node:node scripts ./scripts
RUN chmod +x ./docker-entrypoint.sh

# Non-root. The `node` user (uid 1000) ships with the official image.
RUN mkdir -p /app/.next/cache && chown -R node:node /app
USER node

EXPOSE 3000

# Liveness probe: `/healthz` answers 200 whenever this process is serving HTTP,
# and reports db/schema/redis/trading in the body. It is deliberately NOT
# `/api/v1/health`: that endpoint answers 503 while Redis is unreachable, and a
# container healthcheck that follows Redis makes an orchestrator RESTART a
# healthy web process (and, on Railway, can fail an otherwise-good deploy)
# because of a dependency the web tier does not need to serve a page. A really
# unmigrated database is still caught before traffic: the entrypoint runs
# `prisma migrate deploy` and exits non-zero.
# Uses the *bound* port: managed platforms (Railway, Render) inject PORT and
# the app binds `0.0.0.0:${PORT}` (`npm start` → `next start -H 0.0.0.0`, which
# reads PORT), so a hardcoded 3000 here would report unhealthy on a perfectly
# working deployment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" > /dev/null 2>&1 || exit 1

# The entrypoint runs `prisma migrate deploy` BEFORE the server accepts traffic
# (and exits non-zero if it fails), so no replica can ever serve against an
# un-migrated schema — see docker-entrypoint.sh for the incident this prevents.
ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
