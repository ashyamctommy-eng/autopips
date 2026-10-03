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
# FAIL-CLOSED, BUT NOT FLAP-HAPPY
#   `set -e`: if the migration fails, the container exits non-zero instead of
#   serving traffic against an unknown schema. Railway's restart policy retries,
#   and its healthcheck gate keeps the new deployment out of rotation.
#
#   A *transient* connectivity failure is retried with backoff first. Postgres can
#   legitimately need a moment on a fresh deploy (a service just provisioned, a
#   failover, a network blip), and crash-looping the container — which restarts
#   the whole migration attempt and can exhaust Railway's restart budget — is a
#   worse answer than waiting a few seconds. Only connectivity errors are retried:
#   a genuine migration error fails immediately, because retrying a broken
#   migration just delays the honest failure.
# ─────────────────────────────────────────────────────────────────────────────
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set on this service." >&2
  exit 1
fi

# Call the binary the Dockerfile installed into this image directly: no npx
# resolution, no chance of a network fetch at boot. If it is missing the
# container fails here rather than serving against an unknown schema.
if [ ! -x ./node_modules/.bin/prisma ]; then
  echo "[entrypoint] FATAL: prisma CLI missing from the image (see Dockerfile runner stage)." >&2
  exit 1
fi

MIGRATE_MAX_ATTEMPTS="${MIGRATE_MAX_ATTEMPTS:-10}"

# Prisma error codes / messages that mean "the database is not reachable yet"
# rather than "this migration is wrong": P1000 auth, P1001 cannot reach server,
# P1002 timed out, P1003 database does not exist yet, P1017 connection closed.
CONNECTIVITY_PATTERN='P1000|P1001|P1002|P1003|P1017|Can.t reach database server|Connection refused|ECONNREFUSED|ETIMEDOUT|Timed out|connection.*closed'

echo "[entrypoint] applying database migrations (prisma migrate deploy)…"
attempt=1
delay=2
while true; do
  if migrate_output="$(./node_modules/.bin/prisma migrate deploy 2>&1)"; then
    printf '%s\n' "$migrate_output"
    break
  fi

  printf '%s\n' "$migrate_output" >&2

  if ! printf '%s' "$migrate_output" | grep -Eq "$CONNECTIVITY_PATTERN"; then
    echo "[entrypoint] FATAL: migrations failed and this is not a connectivity error — refusing to serve against an unknown schema." >&2
    exit 1
  fi

  if [ "$attempt" -ge "$MIGRATE_MAX_ATTEMPTS" ]; then
    echo "[entrypoint] FATAL: database still unreachable after ${MIGRATE_MAX_ATTEMPTS} attempts — refusing to serve." >&2
    exit 1
  fi

  echo "[entrypoint] database not reachable yet (attempt ${attempt}/${MIGRATE_MAX_ATTEMPTS}); retrying in ${delay}s…" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  [ "$delay" -gt 20 ] && delay=20
done

# Optional one-time admin bootstrap. Idempotent, and it never overwrites an
# existing account's password — see scripts/bootstrap-admin.mjs.
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "[entrypoint] ensuring bootstrap admin account exists…"
  node scripts/bootstrap-admin.mjs
fi

echo "[entrypoint] starting: $*"
exec "$@"
