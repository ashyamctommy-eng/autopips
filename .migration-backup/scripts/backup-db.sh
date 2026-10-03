#!/usr/bin/env bash
#
# Autopipsz — autopips.pro
# Postgres backup: `pg_dump` the DATABASE_URL database to a timestamped
# custom-format file, then prune old dumps.
#
#   ./scripts/backup-db.sh
#   BACKUP_DIR=/srv/backups BACKUP_RETENTION=30 ./scripts/backup-db.sh
#
# ── SCHEDULING: THIS SCRIPT DOES NOT RUN ITSELF ─────────────────────────────
#   NOTHING IN THIS REPOSITORY SCHEDULES IT. There is no cron entry, no systemd
#   timer and no Railway cron service checked in. Run it from a scheduler YOU
#   create — cron/systemd timer on the host, or a dedicated Railway cron service
#   (`railway.worker.toml`-style config with this command as its start command
#   and a volume mounted at BACKUP_DIR). Until that schedule exists, backups are
#   exactly as manual as SECURITY.md says they are.
#
# ── RESTORE (custom format is restored with pg_restore, never psql) ─────────
#   pg_restore --list /backups/autopips-20260926T030000Z.dump > /dev/null   # verify first
#   createdb autopips_restore
#   pg_restore --clean --if-exists --no-owner \
#     --dbname="postgresql://user:pass@host:5432/autopips_restore" \
#     /backups/autopips-20260926T030000Z.dump
#   Always restore into a SCRATCH database first; `--clean` on the live database
#   drops the objects it is about to replace.
#
# ── SECRETS ────────────────────────────────────────────────────────────────
#   DATABASE_URL is passed to pg_dump as a libpq connection string and is NEVER
#   echoed, logged, or written to a file by this script; pg_dump's stderr is
#   filtered through `redact_stream` before it reaches the console. Do NOT run
#   this script with `bash -x` — that would print the URL.
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
#   * no off-host upload (copy the dump to object storage yourself — see
#     DEPLOYMENT.md section 11.2)
#   * no encryption at rest (the manual gpg recipe in DEPLOYMENT.md is the
#     encrypted variant)
#   * no WAL archiving / PITR, no restore, no schema migration
#   * retention counts FILES in BACKUP_DIR; it does not manage off-host copies
#
# Exit code: 0 = one new dump written (pruning best-effort), 1 = failure.
#
# Portability: POSIX-style syntax; the only non-POSIX feature is
# `set -o pipefail`, supported by bash, ash/busybox and current dash.

set -euo pipefail

# ── configuration (environment, with safe defaults) ─────────────────────────
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"

usage() {
  cat <<'EOF'
Usage: backup-db.sh

Environment:
  DATABASE_URL       (required) libpq connection string to dump. Never printed.
  BACKUP_DIR         output directory for autopips-<UTC>.dump files.
                     Default: ./backups
  BACKUP_RETENTION   how many dump files to keep; older files are pruned after
                     a successful dump. Must be >= 1. Default: 14

The dump is written in Postgres custom format (-Fc) and is restored with
pg_restore. See the header of this file for the restore recipe. This script
must be scheduled externally: nothing in this repository runs it.
EOF
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  '') ;;
  *)
    echo "FATAL: unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac

# ── preconditions ───────────────────────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set. Export it (or load your env file) before running this script." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "FATAL: pg_dump is not on PATH. Install the postgresql client (it must match or exceed the server major version)." >&2
  exit 1
fi

case "$BACKUP_RETENTION" in
  '' | *[!0-9]*)
    echo "FATAL: BACKUP_RETENTION must be an integer (got: ${BACKUP_RETENTION})." >&2
    exit 1
    ;;
esac
if [ "$BACKUP_RETENTION" -lt 1 ]; then
  echo "FATAL: BACKUP_RETENTION must be >= 1; refusing to run with a retention that would delete the dump it just wrote." >&2
  exit 1
fi

# Dumps contain every client KYC document and the whole ledger: keep them
# unreadable to anyone else on the host.
umask 077

if ! mkdir -p "$BACKUP_DIR"; then
  echo "FATAL: cannot create BACKUP_DIR (${BACKUP_DIR})." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_FILE="${BACKUP_DIR%/}/autopips-${STAMP}.dump"
PARTIAL_FILE="${OUTPUT_FILE}.partial"
ERROR_LOG="$(mktemp "${TMPDIR:-/tmp}/autopips-pgdump.XXXXXX")"

cleanup() {
  rm -f "$PARTIAL_FILE" "$ERROR_LOG"
}
trap cleanup EXIT INT TERM HUP

# ── helpers ─────────────────────────────────────────────────────────────────
# Redact credentials from any text before it reaches the console.
#   scheme://user:password@host  ->  scheme://user:[redacted]@host
#   password=...                 ->  password=[redacted]
redact_stream() {
  sed -E \
    -e 's#([A-Za-z][A-Za-z0-9+.-]*://[^/@:[:space:]]*):[^@/[:space:]]*@#\1:[redacted]@#g' \
    -e 's#([Pp]assword=)[^&[:space:]]*#\1[redacted]#g' \
    "$1"
}

# ── dump ────────────────────────────────────────────────────────────────────
echo "Backing up to ${OUTPUT_FILE} (custom format, from DATABASE_URL)"

if ! pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --dbname="$DATABASE_URL" \
  --file="$PARTIAL_FILE" \
  2>"$ERROR_LOG"; then
  echo "FATAL: pg_dump failed. Output was:" >&2
  redact_stream "$ERROR_LOG" >&2
  exit 1
fi

if [ ! -s "$PARTIAL_FILE" ]; then
  echo "FATAL: pg_dump reported success but produced an empty file. Treat the dump as missing." >&2
  exit 1
fi

# Custom-format archives start with the magic bytes "PGDMP". A truncated or
# plain-SQL file is not a usable backup, so refuse to rename it into place.
MAGIC="$(head -c 5 "$PARTIAL_FILE" 2>/dev/null || true)"
if [ "$MAGIC" != "PGDMP" ]; then
  echo "FATAL: dump is not Postgres custom format (magic was '${MAGIC}'). Not keeping it." >&2
  exit 1
fi

mv -- "$PARTIAL_FILE" "$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE" 2>/dev/null || true

SIZE_BYTES="$(wc -c <"$OUTPUT_FILE" | tr -d ' ')"
echo "Wrote $(basename "$OUTPUT_FILE") (${SIZE_BYTES} bytes)"

# ── prune ───────────────────────────────────────────────────────────────────
# Filenames sort chronologically (UTC, fixed width), so the newest N survive.
# Pruning is best-effort: a failure here must not fail an otherwise good backup.
TOTAL="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'autopips-*.dump' -print | wc -l | tr -d ' ')"
if [ "$TOTAL" -gt "$BACKUP_RETENTION" ]; then
  if find "$BACKUP_DIR" -maxdepth 1 -type f -name 'autopips-*.dump' -print \
    | LC_ALL=C sort -r \
    | tail -n +"$((BACKUP_RETENTION + 1))" \
    | while IFS= read -r old; do
        [ -n "$old" ] || continue
        if rm -f -- "$old"; then
          echo "Pruned $(basename "$old")"
        else
          echo "WARN: could not prune ${old}" >&2
        fi
      done; then
    :
  else
    echo "WARN: pruning did not complete; old dumps may remain in ${BACKUP_DIR}" >&2
  fi
fi

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'autopips-*.dump' -print | wc -l | tr -d ' ')"
echo "Retention ${BACKUP_RETENTION}: ${REMAINING} dump file(s) kept in ${BACKUP_DIR}"
echo "Done. Copy ${OUTPUT_FILE} off-host and encrypt it — this script does not."
