#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Container entrypoint — the migration gate.
#
# WHY THIS EXISTS
#   Migrations used to run only from `railway.toml` → `deploy.startCommand`
#   ("npx prisma migrate deploy && npm start"). That is a *platform setting*: if
#   Railway does not pick the config file up (Config File Path unset, a Railpack
#   build, a service created before the file existed), the container silently
#   runs the Dockerfile CMD `npm start` against an empty database. The app boots,
#   `/api/v1/health` answers "db: ok" (it only ran SELECT 1), the deployment is
#   promoted — and every page that touches Postgres 500s. On 2026-09-24 that is
#   exactly what shipped, and the site showed a Next.js error digest.
#
#   Baking the migration into the image entrypoint removes the platform from the
#   critical path: it runs on every boot of *this* image, no matter how the
#   container is started.
#
#   `prisma migrate deploy` is idempotent (~1s with nothing to apply) and takes
#   an advisory lock, so concurrent replicas are safe.
#
# FAIL-CLOSED
#   `set -e`: if the migration fails, the container exits non-zero instead of
#   serving traffic against an unknown schema. Railway's restart policy retries,
#   and its healthcheck gate keeps the new deployment out of rotation.
# ─────────────────────────────────────────────────────────────────────────────
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set on this service." >&2
  exit 1
fi

echo "[entrypoint] applying database migrations (prisma migrate deploy)…"
# Call the binary the Dockerfile installed into this image directly: no npx
# resolution, no chance of a network fetch at boot. If it is missing the
# container fails here rather than serving against an unknown schema.
if [ -x ./node_modules/.bin/prisma ]; then
  ./node_modules/.bin/prisma migrate deploy
else
  echo "[entrypoint] FATAL: prisma CLI missing from the image (see Dockerfile runner stage)." >&2
  exit 1
fi

# Optional one-time admin bootstrap. Idempotent, and it never overwrites an
# existing account's password — see scripts/bootstrap-admin.mjs.
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "[entrypoint] ensuring bootstrap admin account exists…"
  node scripts/bootstrap-admin.mjs
fi

echo "[entrypoint] starting: $*"
exec "$@"
