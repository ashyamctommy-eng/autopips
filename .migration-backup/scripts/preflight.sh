#!/usr/bin/env bash
#
# Autopipsz — pre-deployment environment check (autopips.pro)
#
#   ./scripts/preflight.sh                 # reads ./.env
#   ./scripts/preflight.sh .env.staging    # reads another file
#
# Run this on the deploy host AFTER the release is checked out and dependencies
# are installed (`npm ci && npx prisma generate`), and BEFORE `docker compose up`
# or a process restart. It answers one question: "will the app boot, and can it
# reach its datastores?" — `src/lib/env.ts` fails the process at boot on the same
# conditions, so a failure here saves you a crash-looping container.
#
# It NEVER prints a variable VALUE (only names, and PASS/FAIL reasons). Probe
# errors are redacted so a DATABASE_URL/REDIS_URL password cannot leak into CI
# logs or a ticket.
#
# Exit code: 0 = all checks passed, 1 = at least one FAIL.
#
# REQUIRED= lists mirror .env.example together with the zod schema in
# src/lib/env.ts: these are the variables the app cannot start without. Anything
# that has a usable default in the schema (JWT_ISSUER, TTLs, RISK_*, …) is a
# warning, not a failure.

set -uo pipefail

ENV_FILE="${1:-.env}"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_PASS=""; C_FAIL=""; C_WARN=""; C_DIM=""; C_OFF=""
fi

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  %sPASS%s  %s\n' "$C_PASS" "$C_OFF" "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  %sFAIL%s  %s\n' "$C_FAIL" "$C_OFF" "$1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf '  %sWARN%s  %s\n' "$C_WARN" "$C_OFF" "$1"; }
section() { printf '\n%s\n' "$1"; }

# Redact credentials from anything a probe prints: scheme://user:pass@host → scheme://***@host
redact() { sed -E 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^@/[:space:]]+@#\1***@#g'; }

# ── required variables (must exist in the environment or the env file) ───────
REQUIRED_VARS=(
  NEXT_PUBLIC_APP_URL
  WS_INTERNAL_TOKEN
  DATABASE_URL
  REDIS_URL
  JWT_SECRET
  CREDENTIAL_ENCRYPTION_KEY
  NOWPAYMENTS_API_KEY
  NOWPAYMENTS_IPN_SECRET
  DERIV_APP_ID
)

# Secrets that must never be exposed with a NEXT_PUBLIC_ prefix (mirrors the
# boot guard in src/lib/env.ts: /SECRET|TOKEN|KEY|PASSWORD/i).
PUBLIC_SECRET_WORD_RE='(SECRET|TOKEN|KEY|PASSWORD)'
# Placeholders that mean "still the template".
PLACEHOLDER_RE='(CHANGE_ME|change-me|CHANGE-ME|changeme|change_me|your-|_here|<[^>]*>|xxx+|placeholder)'

# ── load the env file without echoing values ─────────────────────────────────
declare -A FILE_VARS=()

load_env_file() {
  local file="$1" raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    # skip blanks and comments
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # KEY=VALUE (optional `export ` prefix, optional surrounding quotes)
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    # strip one layer of matching quotes
    if [[ "$value" =~ ^\".*\"$ ]] || [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    FILE_VARS["$key"]="$value"
  done < "$file"
}

# Resolve a variable: a real environment value wins over the file (same
# precedence as `process.loadEnvFile`, which does not override).
get_var() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return 0
  fi
  if [ -n "${FILE_VARS[$key]+x}" ]; then
    printf '%s' "${FILE_VARS[$key]}"
    return 0
  fi
  return 1
}

has_var() { get_var "$1" > /dev/null 2>&1; }

# ── banner ───────────────────────────────────────────────────────────────────
printf 'Autopipsz preflight — %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '%s\n' "----------------------------------------"
if [ ! -f "$ENV_FILE" ]; then
  section "Environment file"
  fail "env file not found: $ENV_FILE (copy .env.example → .env and fill it in)"
  printf '\nFAIL: cannot continue without an environment file.\n'
  exit 1
fi
printf '%s env file: %s%s\n' "$C_DIM" "$ENV_FILE" "$C_OFF"
load_env_file "$ENV_FILE"

# ── 1. required variables present & not placeholders ─────────────────────────
section "1. Required variables (presence + placeholder check)"
for name in "${REQUIRED_VARS[@]}"; do
  if ! has_var "$name"; then
    fail "$name is missing"
    continue
  fi
  value="$(get_var "$name")"
  if [ -z "$value" ]; then
    fail "$name is empty"
    continue
  fi
  if printf '%s' "$value" | grep -Eq "$PLACEHOLDER_RE"; then
    fail "$name still holds a template placeholder value"
    continue
  fi
  pass "$name is set"
done

# ── 2. NEXT_PUBLIC_* must not name a secret ─────────────────────────────────
section "2. Client-exposed names (NEXT_PUBLIC_* must carry no secret)"
public_found=0
for key in "${!FILE_VARS[@]}"; do
  case "$key" in
    NEXT_PUBLIC_*)
      public_found=1
      if printf '%s' "$key" | grep -Eq "$PUBLIC_SECRET_WORD_RE"; then
        fail "$key looks like a secret but is NEXT_PUBLIC_* — it would be inlined into the browser bundle (src/lib/env.ts refuses to boot on this)"
      else
        pass "$key is a non-secret public name"
      fi
      ;;
  esac
done
# Also scan exported NEXT_PUBLIC_* values, not just the file's.
while IFS= read -r key; do
  [ -z "$key" ] && continue
  public_found=1
  if printf '%s' "$key" | grep -Eq "$PUBLIC_SECRET_WORD_RE"; then
    fail "$key (environment) looks like a secret but is NEXT_PUBLIC_*"
  else
    pass "$key (environment) is a non-secret public name"
  fi
done < <(env | sed -nE 's/^(NEXT_PUBLIC_[A-Za-z0-9_]*)=.*/\1/p')
[ "$public_found" -eq 0 ] && warn "no NEXT_PUBLIC_* variables found (expected NEXT_PUBLIC_APP_URL)"

# ── 3. secret strength ──────────────────────────────────────────────────────
section "3. Secret strength"

if jwt="$(get_var JWT_SECRET)"; then
  if [ "${#jwt}" -ge 32 ]; then
    pass "JWT_SECRET length ${#jwt} (minimum 32)"
  else
    fail "JWT_SECRET is only ${#jwt} chars — src/lib/env.ts requires >= 32 (generate: openssl rand -base64 48)"
  fi
else
  fail "JWT_SECRET is missing (generate: openssl rand -base64 48)"
fi

if cek="$(get_var CREDENTIAL_ENCRYPTION_KEY)"; then
  decoded_bytes=0
  if printf '%s' "$cek" | grep -Eq '^[A-Za-z0-9+/=]{43,44}$' && command -v base64 > /dev/null 2>&1; then
    # base64 shape → measure the decoded key material (matches src/lib/crypto/credential-cipher.ts)
    decoded_bytes="$(printf '%s' "$cek" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]')"
    decoded_bytes="${decoded_bytes:-0}"
  else
    # raw utf8 key: crypto takes the bytes as-is
    decoded_bytes="$(printf '%s' "$cek" | wc -c | tr -d '[:space:]')"
  fi
  if [ "$decoded_bytes" -ge 32 ]; then
    pass "CREDENTIAL_ENCRYPTION_KEY decodes to ${decoded_bytes} bytes (minimum 32)"
  else
    fail "CREDENTIAL_ENCRYPTION_KEY decodes to only ${decoded_bytes} bytes — needs >= 32 (generate: openssl rand -base64 32)"
  fi
else
  fail "CREDENTIAL_ENCRYPTION_KEY is missing (generate: openssl rand -base64 32)"
fi

if wit="$(get_var WS_INTERNAL_TOKEN)"; then
  if [ "${#wit}" -ge 16 ]; then
    pass "WS_INTERNAL_TOKEN length ${#wit} (minimum 16)"
  else
    fail "WS_INTERNAL_TOKEN is only ${#wit} chars — src/lib/env.ts requires >= 16 (generate: openssl rand -hex 32)"
  fi
fi

# ── 4. datastore URLs (shape, then a real connection) ───────────────────────
section "4. Datastore connectivity"

if dburl="$(get_var DATABASE_URL)"; then
  case "$dburl" in
    postgresql://*|postgres://*) pass "DATABASE_URL uses a postgres scheme" ;;
    *) fail "DATABASE_URL does not start with postgresql:// or postgres://" ;;
  esac
else
  fail "DATABASE_URL is missing"
fi

if redisurl="$(get_var REDIS_URL)"; then
  case "$redisurl" in
    redis://*|rediss://*) pass "REDIS_URL uses a redis scheme" ;;
    *) fail "REDIS_URL does not start with redis:// or rediss://" ;;
  esac
fi

probe_ok=1
if ! command -v node > /dev/null 2>&1; then
  fail "node is not on PATH — cannot probe Postgres/Redis (install Node 20+)"
  probe_ok=0
elif [ ! -d "node_modules" ]; then
  fail "node_modules is missing — run 'npm ci && npx prisma generate' first"
  probe_ok=0
fi

if [ "$probe_ok" -eq 1 ]; then
  # `@prisma/client` (generated) and `ioredis` are the exact drivers the app
  # uses, so this probes the same transports the runtime will use — no psql or
  # redis-cli required on the host. Output is redacted; nothing prints the URL.
  # The two URLs are passed to the probe as a command-scoped environment: the
  # probe must test the RESOLVED values from $ENV_FILE, not whatever the ambient
  # environment happens to hold. They are never echoed.
  # NB: `@prisma/client` loads a repo `.env` on its own; dotenv semantics mean an
  # already-set DATABASE_URL wins, which is exactly why it must be exported here.
  probe_output="$(
    DATABASE_URL="$(get_var DATABASE_URL 2>/dev/null || true)" \
    REDIS_URL="$(get_var REDIS_URL 2>/dev/null || true)" \
    node -e '
      const redact = (s) =>
        String(s).replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g, "$1***@");
      const lastLine = (e) => {
        const msg = e && e.message ? String(e.message) : String(e);
        const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
        return redact(lines[lines.length - 1] || msg);
      };
      (async () => {
        let ok = true;

        if (!process.env.DATABASE_URL) {
          ok = false;
          console.log("CHECK postgres FAILED DATABASE_URL was not passed to the probe");
        } else {
          const PrismaClient = require("@prisma/client").PrismaClient;
          const prisma = new PrismaClient();
          try {
            await prisma.$queryRawUnsafe("SELECT 1");
            console.log("CHECK postgres OK");
          } catch (e) {
            ok = false;
            console.log("CHECK postgres FAILED " + lastLine(e));
          } finally {
            await prisma.$disconnect().catch(() => undefined);
          }
        }

        if (!process.env.REDIS_URL) {
          ok = false;
          console.log("CHECK redis FAILED REDIS_URL was not passed to the probe");
        }
        if (process.env.REDIS_URL) {
          try {
            const mod = require("ioredis");
            const Redis = mod.Redis || mod.default || mod;
            const client = new Redis(process.env.REDIS_URL, {
              lazyConnect: true,
              connectTimeout: 3000,
              maxRetriesPerRequest: 1,
              retryStrategy: () => null,
            });
            client.on("error", () => undefined);
            const pong = await client.ping();
            if (pong === "PONG") {
              console.log("CHECK redis OK");
            } else {
              ok = false;
              console.log("CHECK redis FAILED unexpected reply");
            }
            client.disconnect();
          } catch (e) {
            console.log("CHECK redis FAILED " + lastLine(e));
            ok = false;
          }
        }
        process.exit(ok ? 0 : 1);
      })().catch(() => process.exit(1));
    ' 2>&1
  )"

  while IFS= read -r line; do
    case "$line" in
      "CHECK postgres OK") pass "Postgres connection + SELECT 1 succeeded" ;;
      "CHECK postgres FAILED "*) fail "Postgres unreachable — ${line#CHECK postgres FAILED }" ;;
      "CHECK redis OK") pass "Redis connection + PING succeeded" ;;
      "CHECK redis FAILED "*) fail "Redis unreachable — ${line#CHECK redis FAILED }" ;;
      *) ;; # driver noise (warnings) is ignored on purpose
    esac
  done <<< "$probe_output"
fi

# ── 5. advisory checks (warnings only) ──────────────────────────────────────
section "5. Advisory"

node_env="$(get_var NODE_ENV || true)"
if [ "$node_env" != "production" ]; then
  warn "NODE_ENV is '${node_env:-unset}' — set NODE_ENV=production for a deployment. The socket runtime binds 127.0.0.1 unless NODE_ENV=production, so the worker would be unreachable from the proxy."
else
  pass "NODE_ENV=production"
fi

# KYC documents are stored inside the platform (encrypted, in Postgres) — there is
# no object-storage variable and no signed-URL lifetime to validate here.

if has_var NEXT_PUBLIC_WS_URL; then
  warn "NEXT_PUBLIC_WS_URL is set — the browser will connect to that host directly instead of same-origin /ws/socket.io. Only do this when that hostname really serves the worker."
else
  pass "NEXT_PUBLIC_WS_URL unset (browser uses same-origin /ws/socket.io through the proxy)"
fi

max_pos="$(get_var RISK_MAX_OPEN_POSITIONS || true)"
if [ -n "$max_pos" ] && [ "$max_pos" -eq 0 ] 2>/dev/null; then
  warn "RISK_MAX_OPEN_POSITIONS=0 halts all new entries (the risk gate is fail-closed)"
fi

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n%s\n' "----------------------------------------"
printf 'Summary: %s%d passed%s, %s%d failed%s, %s%d warning(s)%s\n' \
  "$C_PASS" "$PASS_COUNT" "$C_OFF" "$C_FAIL" "$FAIL_COUNT" "$C_OFF" "$C_WARN" "$WARN_COUNT" "$C_OFF"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf '%sFAIL%s — %d check(s) must be fixed before deploying.\n' "$C_FAIL" "$C_OFF" "$FAIL_COUNT"
  exit 1
fi

printf '%sPASS%s — environment looks deployable.\n' "$C_PASS" "$C_OFF"
exit 0
