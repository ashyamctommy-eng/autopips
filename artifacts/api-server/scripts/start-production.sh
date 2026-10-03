#!/usr/bin/env bash
set -euo pipefail

# Published services share one instance. Only the API owns Redis; the worker
# waits for it. Workspace workflows are deliberately independent of this script.
redis_pid=""
app_pid=""
cleanup() {
  trap - EXIT TERM INT
  if [[ -n "$app_pid" ]]; then kill -TERM "$app_pid" 2>/dev/null || true; fi
  if [[ -n "$redis_pid" ]]; then kill -TERM "$redis_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

case "${1:-}" in
  api)
    if [[ "${REDIS_URL:-}" != "redis://127.0.0.1:6379" ]]; then
      echo "Local Redis startup requires REDIS_URL=redis://127.0.0.1:6379" >&2
      exit 1
    fi
    # Redis is ephemeral coordination state. Financial records stay in Postgres.
    mkdir -p /tmp/autopips-redis
    redis-server --bind 127.0.0.1 --port 6379 --protected-mode yes \
      --appendonly yes --dir /tmp/autopips-redis &
    redis_pid=$!
    entry="index"
    ;;
  worker) entry="worker" ;;
  *) echo "Usage: start-production.sh api|worker" >&2; exit 2 ;;
esac

ready=false
for attempt in {1..60}; do
  if [[ -n "$redis_pid" ]] && ! kill -0 "$redis_pid" 2>/dev/null; then
    echo "Redis exited during startup" >&2
    exit 1
  fi
  if [[ "$(redis-cli -h 127.0.0.1 -p 6379 PING 2>/dev/null || true)" == "PONG" ]]; then
    ready=true
    break
  fi
  sleep 0.5
done
if [[ "$ready" != true ]]; then
  echo "Local Redis did not become ready" >&2
  exit 1
fi

node --enable-source-maps "artifacts/api-server/dist/$entry.mjs" &
app_pid=$!
if [[ -n "$redis_pid" ]]; then
  # Any unexpected exit must stop the service, including an exit with status 0.
  wait -n "$redis_pid" "$app_pid"
  exit 1
else
  wait "$app_pid"
  exit 1
fi