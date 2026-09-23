# DEPLOYMENT.md — Autopipsz (autopips.pro)

Operator runbook for the production deployment of the Autopipsz platform.

Everything in this document was written against the code in this repository at
the commit that adds this file — script names, ports, paths, event names and
endpoints are the real ones. Where behaviour is surprising, the file that owns
it is cited so you can re-verify after a change.

---

## 1. What runs where

Two Node processes, two images, one Postgres, one Redis, one reverse proxy.

```
                       ┌────────────────────────────── nginx (host, 443) ─────────────────────────────┐
   browser ──TLS──►    │  /            → 127.0.0.1:3000   Next.js 14 (`npm start` → `next start`)     │
   (HTTPS + WSS)       │  /api/        → 127.0.0.1:3000   route handlers (incl. the NOWPayments IPN)  │
                       │  /_next/static→ 127.0.0.1:3000                                                │
                       │  /ws/ + /socket.io/ → 127.0.0.1:4001   Socket.IO (WebSocket upgrade)          │
                       │  /internal/publish  → 404 (never exposed)                                     │
                       └──────────────────────────────────────────────────────────────────────────────┘
                                 │                                   │
                                 ▼                                   ▼
                        web  (Dockerfile, port 3000)        worker (Dockerfile.worker, port 4001)
                        Next.js App Router only             socket.io + bot runtime + broker sync
                                 │                                   │
                                 └───────────────┬───────────────────┘
                                                 ▼
                                  Postgres 16 (data)   Redis 7 (sessions, rate
                                  + Redis 7 (bus)       limits, IPN replay guard,
                                                        bot lock, pub/sub bus)
```

* **web** — `Dockerfile`, `npm start` (`next start`), port **3000**. Serves pages
  and `/api/**` route handlers. It publishes realtime events by writing to the
  Redis pub/sub channel `autopips:ws:events` (`src/server/ws/event-bus.ts`), so
  it does not talk to the worker directly.
* **worker** — `Dockerfile.worker`, `npm run start:ws`
  (= `tsx src/server/main.ts`), port **`WS_PORT`**, default **4001**. Serves
  `GET /healthz` and `POST /internal/publish`, attaches Socket.IO on namespace
  `/ws/trading` with engine.io path `/ws/socket.io`, and starts the bot runtime
  plus the broker sync worker (`src/server/main.ts`).
* **migrate** — one-shot container built from `Dockerfile.worker` that runs
  `npx prisma migrate deploy`. `web` and `worker` wait for it to exit 0.
* **postgres 16-alpine / redis 7-alpine** — `docker-compose.yml`, named volumes
  `pgdata` / `redisdata`, published on the loopback interface only (ports are
  bound to `127.0.0.1`), with healthchecks.

Files added by this deployment work, all at the repository root:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Next.js web image (multi-stage, non-root, healthcheck) |
| `Dockerfile.worker` | socket/bot runtime image |
| `docker-compose.yml` | the production-shaped stack above |
| `deploy/nginx/autopips.pro.conf` | TLS termination, HTTP→HTTPS, `/ws/` upgrade proxy |
| `.github/workflows/ci.yml` | CI: typecheck, lint, build, tests (with and without a DB) |
| `.dockerignore` | build-context hygiene (no `.env`, no `node_modules`, no tests) |
| `scripts/preflight.sh` | pre-deploy environment/connectivity gate |
| `SECURITY.md` | security posture + honest limitations |

---

## 2. Prerequisites

**Host**
* 64-bit Linux, 2 vCPU / 4 GB RAM / 40 GB SSD minimum (Postgres + Redis + two
  Node processes; the images are ~400 MB each).
* Docker Engine 24+ and Docker Compose v2 (`docker compose version`).
* nginx 1.18+ (1.25.1+ for the `http2 on;` directive used in the proxy file —
  see the note inside that file for the older syntax).
* Ports 80 and 443 open to the internet. **Postgres 5432, Redis 6379, 3000 and
  4001 must NOT be exposed** — compose publishes 3000/4001 on `127.0.0.1` only.
* Outbound HTTPS (443): `api.nowpayments.io`, MetaApi endpoints
  (`*.metaapi.cloud`), your S3 endpoint, and `fonts.googleapis.com` /
  `fonts.gstatic.com` **at image build time** (`next/font/google` downloads the
  Inter and JetBrains Mono subsets during `next build`; the build fails without
  network access).

**Accounts / infrastructure**
* A domain: `autopips.pro` (and `www.autopips.pro`) with A/AAAA records pointing
  at the host.
* An AWS S3 bucket for KYC documents (private; see §6).
* A NOWPayments account with an API key and the IPN secret (see §7).
* A MetaApi.cloud account with an API token and at least one **deployed** MT4/MT5
  account (see §8).

**Local tooling used below**: `git`, `openssl`, `curl`, `jq` (optional, for
pretty JSON), `node` 20+ (only if you want to run `npm` tooling or
`scripts/preflight.sh` on the host — preflight uses the repo's own
`@prisma/client` + `ioredis` to probe the datastores).

---

## 3. Environment contract

`cp .env.example .env`, then fill in every value. `.env` is git-ignored
(`.gitignore`) and excluded from the Docker build context (`.dockerignore`) —
**never commit it, never paste it into a ticket, never pass it as a build arg**
(build args are recorded in image history; only `NEXT_PUBLIC_*` values may be
build args, see the `Dockerfile` header).

All values are validated at boot by `src/lib/env.ts`. A missing or malformed
variable makes the process **exit 1 immediately** with the offending field named.
The same file refuses to boot if a variable named like a secret is prefixed with
`NEXT_PUBLIC_`.

### 3.1 Runtime

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | yes (production) | no | `production` enables Secure cookies, CORS allow-list and the worker binding `0.0.0.0`. Defaults to `development` if unset — always set it. | `production` |
| `NEXT_PUBLIC_APP_URL` | yes | no (public) | Canonical origin. Used for socket CORS, site metadata, and to build the per-payment NOWPayments IPN callback (`<url>/api/v1/payments/nowpayments/ipn`). | `https://autopips.pro` |
| `NEXT_PUBLIC_APP_NAME` | no (default `Autopipsz`) | no (public) | Display name. | `Autopipsz` |
| `WS_PORT` | no (default `4001`) | no | Worker HTTP/Socket.IO port. Must match the nginx upstream. | `4001` |
| `WS_INTERNAL_TOKEN` | yes (min 16 chars) | **secret** | Bearer token for `POST /internal/publish` on the worker (timing-safe compare). Shared by web and worker. | `openssl rand -hex 32` |
| `NEXT_PUBLIC_WS_URL` | **normally unset** | no | Only set when the socket runtime is on a *different hostname* than the page. When unset (recommended) `src/lib/socket-client.ts` connects same-origin to `/ws/socket.io` and nginx proxies it. | *(empty)* |

### 3.2 Datastores

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | yes | **secret** (contains the password) | Prisma connection string. Inside compose the host is the service name `postgres`. | `postgresql://autopips:<pw>@postgres:5432/autopips?schema=public&connection_limit=10` |
| `REDIS_URL` | yes | secret if passworded | Sessions/refresh store, rate limits, IPN replay guard, bot lock, WS pub/sub. Web and worker **must share one Redis**. | `redis://redis:6379` |
| `REDIS_TLS` | no (default `false`) | no | `true` for a managed Redis that requires TLS. | `false` |

### 3.3 Authentication

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `JWT_SECRET` | yes (min 32 chars) | **secret** | HS256 signing key for access tokens. Rotating it invalidates every session. | `openssl rand -base64 48` |
| `JWT_ISSUER` | no (default `autopips.pro`) | no | `iss` claim, verified on every request. | `autopips.pro` |
| `JWT_AUDIENCE` | no (default `autopips-pro-clients`) | no | `aud` claim, verified. | `autopips-pro-clients` |
| `ACCESS_TOKEN_TTL` | no (default `900`) | no | Access-token lifetime in seconds (15 min). | `900` |
| `REFRESH_TOKEN_TTL` | no (default `2592000`) | no | Refresh-token / session lifetime in seconds (30 days). | `2592000` |
| `TOTP_ISSUER` | no (default `Autopipsz`) | no | Label shown in the authenticator app. | `Autopipsz` |

### 3.4 Credential encryption at rest

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | yes (must decode to ≥ 32 bytes) | **secret** | AES-256-GCM envelope key for broker/MetaApi tokens and payout secrets stored in the DB (`src/lib/crypto/credential-cipher.ts`). **Changing it makes every stored credential undecryptable** — re-enter broker tokens after a rotation. | `openssl rand -base64 32` |

### 3.5 AWS S3 (private KYC bucket)

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `AWS_REGION` | yes | no | Bucket region. | `eu-west-1` |
| `AWS_ACCESS_KEY_ID` | optional in the schema | **secret** | Access key. **Omit on EC2/ECS and use an instance/task IAM role instead** (the SDK's default provider chain is used; keys are never logged or echoed). | `AKIA…` |
| `AWS_SECRET_ACCESS_KEY` | optional in the schema | **secret** | Matching secret. | `…` |
| `AWS_KYC_BUCKET` | yes | no | The private KYC bucket name. | `autopips-kyc-private` |
| `AWS_KMS_KEY_ID` | optional | no | SSE-KMS key ARN/ID. When set, every PUT uses `aws:kms`; otherwise `AES256`. **Preferred in production.** | `arn:aws:kms:eu-west-1:123456789012:key/uuid` |
| `KYC_SIGNED_URL_TTL` | no (default `300`) | no | Presigned GET lifetime for admin review. **Hard-capped at 300 s in code** — a larger value here is silently clamped. | `300` |

### 3.6 NOWPayments

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `NOWPAYMENTS_API_KEY` | yes | **secret** | Deposit/invoice API key (`x-api-key`). | NOWPayments dashboard → *API keys* |
| `NOWPAYMENTS_API_BASE` | no (default `https://api.nowpayments.io/v1`) | no | API base URL. | `https://api.nowpayments.io/v1` |
| `NOWPAYMENTS_IPN_SECRET` | yes | **secret** | HMAC-SHA512 key for verifying `x-nowpayments-sig`. | NOWPayments dashboard → *Store settings → IPN* (see §7) |
| `NOWPAYMENTS_PAYOUT_WALLET` | optional | secret-ish | Fixed treasury payout wallet. Blank = custodial payout flow / manual settlement. | `T…` |
| `NOWPAYMENTS_PAYOUT_CURRENCY` | no (default `usdttrc20`) | no | Default payout currency. | `usdttrc20` |
| `NOWPAYMENTS_ALLOWED_CURRENCIES` | no (default listed) | no | Allow-list shown on the deposit screen. | `usdttrc20,usdterc20,btc,eth,ltc,trx,bnb` |
| `NOWPAYMENTS_PAYOUT_JWT` **or** `NOWPAYMENTS_PAYOUT_EMAIL` + `NOWPAYMENTS_PAYOUT_PASSWORD` | optional | **secret** | Out-of-band payout credentials (§7.3). Deliberately **not** part of `src/lib/env.ts` — the app boots without them and falls back to manual settlement. | see §7.3 |

### 3.7 MetaApi.cloud

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `METAAPI_TOKEN` | yes | **secret** | MetaApi account-scoped API token. | MetaApi dashboard → *API access* |
| `METAAPI_REGION` | no (default `new-york`) | no | Region of the *deployment* the accounts live in. **Must match where the MT4/MT5 accounts were created.** | `new-york` / `london` / `singapore` |
| `METAAPI_SYNC_INTERVAL` | no (default `15`) | no | Seconds between broker polls in the bot loop (floored at 5 s in code). | `15` |
| `METAAPI_RISK_MANAGEMENT_ENABLED` | no (default `true`) | no | Additionally use MetaApi's own risk-management API. Additive to — never a replacement for — the local pre-trade gate. | `true` |
| `METAAPI_TERMINAL_TIMEOUT` | no (default `120`) | no | Seconds to wait for terminal synchronization on connect. | `120` |

### 3.8 Risk engine / business guards

| Variable | Required | Secret | Purpose | Example |
| --- | --- | --- | --- | --- |
| `RISK_MASTER_EQUITY_FLOOR_USD` | no (default `0`) | no | Bot halts **new** entries when master equity is below this. | `0` |
| `RISK_MAX_OPEN_POSITIONS` | no (default `50`) | no | Max concurrent open positions across all clients. `0` halts all new entries. | `50` |
| `RISK_MAX_LOT_PER_ORDER` | no (default `10`) | no | Max lot size for a single client order. | `10` |
| `RISK_MIN_CLIENT_CAPITAL_USD` | no (default `100`) | no | Minimum client capital before the allocator mirrors a trade. | `100` |
| `RISK_HWM_ENABLED` | no (default `true`) | no | Performance fee only on new high-water-mark profit. | `true` |

### 3.9 Compose-only variables (not read by the app)

| Variable | Required | Secret | Purpose |
| --- | --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_DB` | no (default `autopips`) | no | Database/role created by the `postgres` container. Must match `DATABASE_URL`. |
| `POSTGRES_PASSWORD` | **yes (compose fails without it)** | **secret** | Password for that role. Must match the password inside `DATABASE_URL`. Generate: `openssl rand -base64 24`. |

### 3.10 Generating the secrets

```bash
JWT_SECRET="$(openssl rand -base64 48)"                       # ≥ 32 chars, base64
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"        # exactly 32 bytes → 44-char base64
WS_INTERNAL_TOKEN="$(openssl rand -hex 32)"                   # 64 hex chars ≥ 16
POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"  # URL-safe, matches DATABASE_URL
```

Store them in your secret manager (AWS Secrets Manager / 1Password / Vault) and
write them into `.env` on the host with `chmod 600 .env`. Never reuse the
`NEXT_PUBLIC_*` names for any of them.

---

## 4. First deployment

```bash
# 0. get the release onto the host
git clone <repo> /opt/autopips && cd /opt/autopips
git checkout <release-tag>

# 1. environment
cp .env.example .env && chmod 600 .env
$EDITOR .env            # fill in every value; adjust DATABASE_URL/REDIS_URL hosts
                        # to the compose service names (postgres, redis) — see §3

# 2. gate: environment + datastore reachability (fails non-zero, prints no secrets)
./scripts/preflight.sh

# 3. build both images
docker compose build

# 4. schema migration (one-shot; `prisma migrate deploy` applies prisma/migrations/**)
docker compose up -d postgres redis
docker compose up -d migrate
docker compose logs -f migrate        # wait for "All migrations have been successfully applied."

# 5. start the app + the socket/bot runtime
docker compose up -d web worker

# 6. verify
curl -fsS http://127.0.0.1:3000/ > /dev/null && echo "web ok"
curl -fsS http://127.0.0.1:4001/healthz | jq .   # {"ok":true,"db":{"status":"ok"},"redis":{"status":"ok"},...}
```

Then continue with §5 (TLS/DNS) and run the smoke checklist in §12.

**Note on `docker compose up -d`**: `web` and `worker` declare
`depends_on: migrate: condition: service_completed_successfully`, so a plain
`docker compose up -d` performs steps 4–5 in the right order. Re-run migrations
explicitly after a release that adds migrations:
`docker compose run --rm migrate` (or `docker compose up -d --force-recreate migrate`).

**Do not use `prisma migrate dev` in production** — it can reset the database.
`npm run prisma:deploy` / `npx prisma migrate deploy` is the only deploy-time
migration command.

---

## 5. TLS, DNS and the WebSocket proxy

1. **DNS** — point `autopips.pro` (A and, if you have IPv6, AAAA) and
   `www.autopips.pro` (CNAME → `autopips.pro`) at the host. Port 80 must be
   reachable for the ACME HTTP-01 challenge.
2. **Certificate** — `deploy/nginx/autopips.pro.conf` expects certbot paths under
   `/etc/letsencrypt/live/autopips.pro/`:

   ```bash
   sudo mkdir -p /var/www/certbot
   sudo certbot certonly --webroot -w /var/www/certbot \
        -d autopips.pro -d www.autopips.pro \
        --email ops@autopips.pro --agree-tos --no-eff-email
   echo 'systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh
   sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh
   ```

3. **Install the proxy config**

   ```bash
   sudo cp deploy/nginx/autopips.pro.conf /etc/nginx/conf.d/autopips.pro.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```

   The file is written for the `http {}` context (it declares `map`/`upstream`);
   it must not be included from inside another `server {}` block.

4. **The WebSocket requirement (read this before changing the proxy)** —
   `src/lib/socket-client.ts` connects to namespace `/ws/trading` with path
   `/ws/socket.io`. When `NEXT_PUBLIC_WS_URL` is unset it resolves that against
   the **page origin** (`https://autopips.pro`), because the socket server is a
   *separate process* — a Next.js rewrite cannot carry the HTTP upgrade to
   another port. nginx must therefore proxy `/ws/` (and `/socket.io/`) to
   `127.0.0.1:4001` with:

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade    $http_upgrade;
   proxy_set_header Connection $connection_upgrade;   # map: upgrade / close
   proxy_read_timeout  3600s;
   proxy_buffering off;
   ```

   The client starts on `polling` and upgrades to `websocket`. Miss the
   `Upgrade`/`Connection` headers and the transport stays on polling forever
   (no 500 anywhere — it just looks "slow"). Set `NEXT_PUBLIC_WS_URL` **only** if
   the socket runtime is genuinely on another hostname — and note that the worker
   then only accepts browser origins listed in
   `corsOrigins` (= `NEXT_PUBLIC_APP_URL` in production).

5. `POST /internal/publish` is answered with `404` by the proxy on purpose. Use
   it only from inside the host:

   ```bash
   curl -fsS -X POST http://127.0.0.1:4001/internal/publish \
     -H "Authorization: Bearer $WS_INTERNAL_TOKEN" -H 'content-type: application/json' \
     -d '{"event":"bot:activity","payload":{"id":"smoke","message":"manual publish","severity":"info"}}'
   ```

   Accepted event names (broadcastable server events only):
   `trade:opened`, `trade:updated`, `trade:closed`, `price:tick`,
   `account:equity`, `bot:activity`, `broker:status`.
   `trading:subscribe` / `trading:unsubscribe` are client→server events and are
   rejected here.

---

## 6. S3 bucket for KYC documents

The platform has no third-party identity-verification service: identity documents
go to a **private** bucket and leave it only as short-lived presigned URLs minted
for a signed-in admin (`src/server/modules/kyc/storage.service.ts`).

Required posture:

1. **Block Public Access: ON** (all four switches). No public bucket policy, no
   ACLs. KYC documents are passports and selfies; a public object is a breach.
2. **Bucket policy: deny any request where `aws:SecureTransport` is false.**
3. **Encryption at rest:** SSE-KMS with a customer-managed key (`AWS_KMS_KEY_ID`)
   is preferred; without it the module falls back to SSE-S3 `AES256`. There is no
   code path that uploads without server-side encryption, and a caller cannot
   supply its own encryption parameters or canned ACL — those are rejected by a
   client middleware guard.
4. **Object keys are unguessable**: `kyc/<userId>/<uuid>/<kind>-<uuid>.<ext>`,
   extension derived from the validated content type, never from the client
   filename.
5. **No public URL is ever produced.** The only URL the module can mint is a
   presigned `GetObject` URL, capped at **300 seconds** regardless of
   `KYC_SIGNED_URL_TTL`, and every read is written to `AuditLog` as
   `KYC_DOCUMENT_VIEWED`.
6. **Uploads are bounded**: 10 MB per document, allow-listed content types
   (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`) and four slots
   (`idFront`, `idBack`, `proofOfAddress`, `selfie`). nginx allows 12 MB per
   request so multipart framing is never the thing that 413s a legitimate upload.
7. **Credentials:** prefer an IAM role on the instance (leave
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` blank — they are optional in the
   schema), otherwise a dedicated IAM user limited to
   `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on that one
   bucket (+ `kms:Encrypt`/`kms:Decrypt`/`kms:GenerateDataKey` on the KMS key).
8. Turn on **versioning** and an **object-lock/retention or lifecycle rule**
   appropriate to your KYC retention obligation, and enable access logging /
   CloudTrail data events for the bucket.

---

## 7. NOWPayments setup

### 7.1 Where the IPN secret is

NOWPayments dashboard → **Store settings → IPN** (some accounts show it under
*Account → API keys* as "IPN secret key"). Copy it into
`NOWPAYMENTS_IPN_SECRET`. It is **not** the same value as `NOWPAYMENTS_API_KEY`.
The platform verifies the `x-nowpayments-sig` request header as
`HMAC-SHA512(canonicalised_body, NOWPAYMENTS_IPN_SECRET)` with a timing-safe
comparison (`src/server/modules/payments/ipn.service.ts`).

### 7.2 Which URL to register

Register this exact URL as the IPN callback in the NOWPayments dashboard:

```
https://autopips.pro/api/v1/payments/nowpayments/ipn
```

The route is `src/app/api/v1/payments/nowpayments/ipn/route.ts` and is
**intentionally unauthenticated** — the HMAC signature *is* the authentication.
Notes:

* The app also sends `ipn_callback_url` per payment, built from
  `NEXT_PUBLIC_APP_URL` + the same path. So `NEXT_PUBLIC_APP_URL` must be the
  public HTTPS origin, with no trailing slash issues (`payments.service.ts`
  strips trailing slashes).
* **Never rewrite the request body or scrub the header in the proxy.** The route
  hashes `await request.text()` — the raw bytes. A JSON re-serialiser, a
  `sub_filter`, or a proxy that drops `x-nowpayments-sig` breaks the digest and
  every genuine callback is rejected with 401 (audited as
  `DEPOSIT_IPN_REJECTED`), so no deposit would ever be credited. The nginx conf
  documents the pass-through explicitly and deliberately does not enable
  `proxy_request_buffering off` (buffering is safe; streamed/interfered bodies
  are not).
* Replay/duplicate deliveries are handled in-app: `claimOnce('ipn:<paymentId>:<status>', 86400)`
  in Redis makes a repeat delivery a no-op, and the endpoint still ACKs `200`
  (NOWPayments would otherwise retry forever). This guard **fails closed** while
  Redis is down (deliveries are treated as already processed; deposits are
  recovered by the idempotent reconciliation path) — see §11.
* Deposit crediting is status-driven: `CONFIRMED`/`FINISHED` credit,
  `partially_paid` stays `PENDING`, `expired` becomes `FAILED`.

### 7.3 Payout credentials (out of band)

Automated payouts need the NOWPayments **payout** API, which is *not*
API-key-authenticated; it needs a JWT minted from an email + password
(`POST /v1/auth`). Supply one of these in the worker's environment — they are
deliberately **outside** `src/lib/env.ts`, so the app boots without them and
withdrawals fall back to operator settlement:

```bash
NOWPAYMENTS_PAYOUT_JWT=...                         # pre-minted, rotated by the operator
# or
NOWPAYMENTS_PAYOUT_EMAIL=...
NOWPAYMENTS_PAYOUT_PASSWORD=...
```

With neither set, `createPayout()` throws a payment error whose message says
manual settlement is required: approve the withdrawal, pay it from the treasury
wallet, then record the `txHash` (an admin action). The platform never fabricates
a `txHash` and never reports a payout that did not happen. These values are also
scrubbed from error messages before they are logged.

---

## 8. MetaApi setup

1. Create/sign in to the MetaApi.cloud dashboard and copy the **API token**
   into `METAAPI_TOKEN`.
2. Pick the **region** where your MT4/MT5 accounts will be created and set
   `METAAPI_REGION` to the same value (`new-york`, `london`, `singapore`, …).
   The adapter constructs `new MetaApi(token, { region })`
   (`src/server/modules/broker/metaapi.adapter.ts`); a mismatch means the SDK
   cannot see the account.
3. **Add the trading account in the MetaApi dashboard** (login, server, password,
   platform MT4/MT5, DEMO or LIVE) and **deploy it**. The account must reach the
   `DEPLOYED` state — the platform reads `account.state` verbatim and surfaces it
   as the raw state string; an undeployed account yields no positions, no candles
   and therefore no signals, and the bot will log connection failures per tick
   rather than invent data.
4. In the admin UI, add the account as a **broker connection**
   (`POST /api/v1/admin/brokers` with `metaApiAccountId`, environment
   `LIVE`/`DEMO`, and the account token). The per-account token is stored
   AES-256-GCM encrypted with `CREDENTIAL_ENCRYPTION_KEY` and is never returned by
   an API response.
5. Optional: enable MetaApi's risk-management API
   (`METAAPI_RISK_MANAGEMENT_ENABLED=true`). This is **additive** to the local
   fail-closed pre-trade gate, never a replacement.
6. Tune `METAAPI_TERMINAL_TIMEOUT` if your broker is slow to synchronise, and
   `METAAPI_SYNC_INTERVAL` for poll frequency (floored at 5 s).

---

## 9. The bot runtime: singleton by design

* The bot takes a Redis lock — key `autopips:lock:bot-runtime`, `SET NX EX 60`,
  renewed every tick with a compare-and-set Lua script, released (only by the
  owner) on shutdown (`src/server/modules/bot/bot.runtime.ts`).
* A replica that starts while the lock is held logs
  `[bot.runtime] refusing to start — LOCK_HELD: another bot runtime already owns autopips:lock:bot-runtime`
  and **never starts its trading loop**. It still serves `/healthz` and sockets.
  There is **no retry** — the loop starts only at boot.
* A replica that loses the lock mid-flight stops its own loop (`lock-lost`)
  rather than trading alongside the new owner.
* Two runtimes trading one master signal would **double every client's exposure**.
  That is the whole reason for the lock.

**How to scale**

| Need | Do |
| --- | --- |
| More request throughput | Scale `web` (stateless; publishes via Redis). |
| More socket fan-out / more concurrent sockets | More worker replicas are *possible* (every replica subscribes to `autopips:ws:events` and clients reconnect) — but each one contends for the bot lock at boot and adds a restart-time race. Prefer a vertical bump first. Keep the count in the deploy notes so nobody is surprised by a `LOCK_HELD` log. |
| More trading throughput | Not achievable by replicating: the bot is deliberately single-writer. Change `strategies` (operator config in `bot.runtime.ts`) instead. |

**Verification after a worker (re)start**

```bash
docker compose logs worker | grep -E "bot.runtime|LOCK_HELD|broker-sync"
# expect: [ws] bot-runtime started via startBotRuntime()  and
#         [bot.runtime] started: interval=15s strategies=[gold-momentum]
```

If you see `LOCK_HELD`, another worker still owns the lock: stop the extra
container, or wait up to the 60 s lock TTL (a hard-killed worker does not release
it early) and restart this one. Readiness (`/healthz` 200) does **not** imply the
trading loop is running — check the logs.

Stopping the worker cleanly: `docker stop` → SIGTERM → the runtime stops the bot,
closes sockets, quits Redis and disconnects Prisma, with a 10 s hard-exit budget.

---

## 10. Deploying a new release

### 10.1 Standard sequence

```bash
cd /opt/autopips
git fetch --tags && git checkout <new-tag>

./scripts/preflight.sh                      # env still valid?
docker compose build                        # new images (old containers keep serving)
docker compose up -d migrate                # migrate first — make migrations backward-compatible
docker compose logs -f migrate              # must exit 0 before continuing
docker compose up -d --no-deps web          # restart the web tier
docker compose up -d --no-deps worker       # restart the socket/bot tier LAST
docker compose ps                           # all healthy?
```

Order matters:

1. **Migrations first, and expand/contract only.** A rolling deploy runs old and
   new code against the same schema, so a release must never drop/rename a column
   the previous release still uses — add, backfill, deploy, then remove in a
   later release.
2. **web before worker.** Socket clients stay connected while web restarts.
3. **worker last.** Restarting it drops every socket (clients auto-reconnect:
   `reconnection: true`, 500 ms → 5 s backoff, unlimited attempts) and briefly
   stops trading until the lock is re-acquired.

### 10.2 Zero-downtime variant for `web`

compose publishes `web` on a fixed host port, so two replicas cannot both bind
`127.0.0.1:3000`. To roll without a single failed request, run the new build on a
second loopback port and move the upstream:

```bash
# 1. start the new image next to the old one (add web-next to a compose override)
cat > docker-compose.override.yml <<'YAML'
services:
  web-next:
    image: autopipsz/web:latest
    env_file: [.env]
    environment: { NODE_ENV: production, PORT: "3001", HOSTNAME: "0.0.0.0" }
    ports: ["127.0.0.1:3001:3001"]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }
    restart: unless-stopped
YAML
docker compose up -d --no-deps web-next
curl -fsS http://127.0.0.1:3001/ > /dev/null   # healthy?

# 2. add `server 127.0.0.1:3001;` to `upstream autopips_web` and reload nginx
sudo $EDITOR /etc/nginx/conf.d/autopips.pro.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. drain the old container, then remove the override and the old server line
docker compose stop web && docker compose rm -f web
rm docker-compose.override.yml
# (keep only 127.0.0.1:3000 in the upstream from now on)
```

nginx's `keepalive` upstream will retry the idle connections; a request in flight
on the removed upstream may still fail (`502`), so drain, don't cut.

### 10.3 Rollback

```bash
# 1. roll the code back
git checkout <previous-tag>
docker compose build && docker compose up -d --no-deps web worker

# 2. if the release shipped a migration, the schema is already forward
#    (migrations are forward-only in this repo — there are no down migrations).
#    Options, in order of preference:
#      a. the previous release still works against the new schema (expand/contract
#         was respected) → do nothing;
#      b. write a forward SQL fix as a NEW migration and `docker compose run --rm migrate`;
#      c. restore from backup (§11) and accept the data loss window.
```

Keep the previous image tags (`docker tag autopipsz/web:latest
autopipsz/web:blue-YYYYMMDD`) so a rollback is a tag flip rather than a rebuild.

### 10.4 Post-deploy smoke checklist

```bash
curl -fsS https://autopips.pro/ -o /dev/null -w '%{http_code}\n'          # 200
curl -fsS https://autopips.pro/api/v1/plans | jq '.ok'                    # true
curl -fsS http://127.0.0.1:4001/healthz | jq '{ok,db:.db.status,redis:.redis.status}'
curl -fsSI https://autopips.pro/ | grep -i strict-transport-security      # HSTS present
curl -s  https://autopips.pro/internal/publish -o /dev/null -w '%{http_code}\n'  # 404
# browser: sign in, load /dashboard/live, confirm the socket connects
#   (DevTools → Network → WS → /ws/socket.io/?EIO=4&transport=websocket)
# admin: /admin → brokers shows the MetaApi account state; logs fill with activity
```

---

## 11. Health, readiness and backups

### 11.1 `GET /healthz` (worker)

```jsonc
{
  "ok": true,                       // false → HTTP 503
  "uptime": 1234.5,
  "connections": 12,                // live socket.io sockets
  "rooms": 9,
  "db":    { "status": "ok", "latencyMs": 3, "detail": "SELECT 1" },
  "redis": { "status": "ok", "latencyMs": 1, "detail": "PONG" },
  "namespace": "/ws/trading",
  "startedAt": "2026-09-23T12:00:00.000Z",
  "pid": 42
}
```

* 200 = Postgres **and** Redis reachable; 503 = at least one is down (each probe
  has a 2 s budget so the endpoint can never hang). Use it as a **readiness**
  probe — the compose healthcheck does exactly that.
* It reports dependencies, **not** whether this replica owns the bot lock.
* `web` has no equivalent JSON endpoint; its healthcheck is `GET /` (200).

**Redis loss is not cosmetic.** Redis holds the refresh-token revocation store
(every user is signed out), the rate-limit buckets, the IPN replay guard
(duplicates are dropped while it is down — fail-closed, recoverable) and the bot
lock (needs re-acquisition). That is why compose runs Redis with
`--appendonly yes`.

### 11.2 Postgres backup / restore

```bash
# nightly, off-box, encrypted (adjust the destination to your storage)
docker compose exec -T postgres pg_dump -U autopips -d autopips -Fc \
  > /backups/autopips-$(date -u +%Y%m%dT%H%M%SZ).dump
gpg --encrypt --recipient ops@autopips.pro /backups/autopips-*.dump

# restore (VERIFY THE DUMP FIRST, and restore into a scratch database)
docker compose exec -T postgres pg_restore -U autopips -d autopips_restore --clean --if-exists \
  < /backups/autopips-<stamp>.dump
```

* Retain ≥ 30 daily + 12 monthly dumps, stored **off the host**, encrypted.
* For a lower RPO: run the Postgres container with WAL archiving
  (`archive_mode=on`, `archive_command` → object storage) and use PITR. Without
  it, your RPO is the dump interval.
* Take a dump **immediately before** any release that includes a migration.
* KYC documents are **not** in Postgres — they live in S3. Back those up with
  versioning plus (ideally) cross-region replication, and keep the same retention
  policy as the database rows that reference them.

### 11.3 Redis backup / restore

```bash
docker compose exec -T redis redis-cli BGREWRITEAOF
docker run --rm -v autopips_redisdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/redis-$(date -u +%Y%m%d).tgz -C /data .
```

Redis here is *reconstructible*: losing it signs every user out, resets rate-limit
buckets and the IPN replay guard and forces the bot to re-acquire its lock. It is
not a source of truth for money (that is Postgres). Treat a Redis restore as a
convenience, not a requirement — and prefer recovering forward.

---

## 12. Logs

| What | Where |
| --- | --- |
| web (Next.js, route handler errors, `[audit]` failures) | `docker compose logs -f web` (json-file driver, rotation is a daemon option — configure `max-size`/`max-file` in `/etc/docker/daemon.json`) |
| worker (`[ws]`, `[bot.runtime]`, `[broker*]`, `[redis]`) | `docker compose logs -f worker` |
| Postgres | `docker compose logs postgres` |
| Redis | `docker compose logs redis` |
| nginx access / errors, ACME, 502s | `/var/log/nginx/access.log`, `/var/log/nginx/error.log`, `journalctl -u nginx` |
| `migrate` (must end with success) | `docker compose logs migrate` |
| Business audit trail (immutable, in-DB) | `AuditLog` table — surfaced in the admin UI at `/admin/audit`, and via `GET /api/v1/admin/logs` |
| Browser-side socket problems | DevTools → Console (`[ws] …`) and Network → WS |

Useful greps:

```bash
docker compose logs worker | grep -E "FATAL|LOCK_HELD|uncaughtException|failed to start"
docker compose logs web    | grep -E "Invalid or missing server environment|\[audit\]"
```

---

## 13. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Container restarts in a loop; logs `[ws] FATAL: invalid environment.` (worker) or `Invalid or missing server environment variables:` (web) | A required variable is missing/empty/wrong shape — `src/lib/env.ts` validates at boot and exits 1 | Run `./scripts/preflight.sh`; fix the named variables; recreate the container (env changes need `docker compose up -d --force-recreate`) |
| `Refusing to boot: NEXT_PUBLIC_… looks like a secret` | A secret was given a `NEXT_PUBLIC_` name (it would be inlined into the browser bundle) | Rename the variable to a server-only name and rebuild the web image (the value is baked into client JS) |
| nginx returns 502 for `/` | `web` not listening / crashed / wrong port mapping | `docker compose ps`, `docker compose logs web`; confirm `127.0.0.1:3000` answers |
| Sockets never upgrade; DevTools shows only `transport=polling` | The proxy is missing the WebSocket upgrade (`proxy_http_version 1.1`, `Upgrade`, `Connection`) or the wrong path is proxied | Check the `/ws/` block, `sudo nginx -t`, then connect to `/ws/socket.io/?EIO=4&transport=websocket` manually |
| Browser console `connect_error: xhr poll error` | `NEXT_PUBLIC_WS_URL` points somewhere wrong, or the socket origin is not in the allow-list (`NEXT_PUBLIC_APP_URL` drives CORS in production) | Unset `NEXT_PUBLIC_WS_URL` and rebuild; make `NEXT_PUBLIC_APP_URL` exactly the origin users visit |
| Worker is up but unreachable from nginx inside the network | `NODE_ENV` is not `production`, so the runtime binds `127.0.0.1` instead of `0.0.0.0` | Set `NODE_ENV=production` on the worker service |
| `/healthz` returns 503 | Postgres or Redis unreachable — the failing dependency is named in the body | Fix the datastore; check `REDIS_URL`/`DATABASE_URL` hosts (compose uses service names, not localhost) |
| IPNs rejected; `AuditLog` shows `DEPOSIT_IPN_REJECTED` | Wrong `NOWPAYMENTS_IPN_SECRET`, or the proxy/body pipeline is rewriting the body or dropping `x-nowpayments-sig` | Re-copy the secret from *Store settings → IPN*; verify the registered callback URL is `https://autopips.pro/api/v1/payments/nowpayments/ipn`; remove any body-rewriting proxy rule |
| Deposits stay `PENDING` though the provider says paid | Redis was down, so the replay guard failed closed and dropped the delivery; or the callback URL is unreachable | Restore Redis, then use the reconciliation/recovery path (it is idempotent) and confirm the `AuditLog` entries |
| `[bot.runtime] refusing to start — LOCK_HELD` | A second worker container owns `autopips:lock:bot-runtime` | Ensure exactly one worker; if the previous container was hard-killed, wait ≤ 60 s (lock TTL) and restart the worker |
| No trades at all, but the socket server is healthy | No `DEPLOYED` MetaApi account, all strategies disabled, or a risk guard is blocking (`RISK_MAX_OPEN_POSITIONS=0`, equity floor, `RISK_MIN_CLIENT_CAPITAL_USD`) | Check the admin broker screen for the raw MetaApi state, then the risk config, then worker logs for per-cycle audit errors |
| Broker connection shows `ERROR`/`DISCONNECTED` | Wrong account id/token, wrong `METAAPI_REGION`, or the account is not deployed | Re-check `METAAPI_REGION`, re-deploy the account in the MetaApi dashboard, re-enter the token in the admin UI |
| Users are signed out after every deploy | Redis was replaced/flushed, or web and worker point at different Redis instances | Make both services use the same `REDIS_URL`; enable AOF persistence (already set in compose) |
| `prisma migrate deploy` fails with `P1001`/connection refused | Postgres not healthy yet, or `DATABASE_URL` uses the wrong host | `docker compose ps postgres`; inside compose the host must be `postgres` |
| KYC upload returns 413 | Request exceeded `client_max_body_size` (12m) or a single document exceeded the 10 MB limit | Check both; the per-document limit is enforced in code and is not configurable |
| Presigned KYC link "expired" after a few minutes | By design — the hard cap is 300 s | Open the document from the admin review screen again |
| Admin screens show empty tables/panels | Some service contracts intentionally return honest empty states (no invented data) | Check the browser network tab / `GET /api/v1/admin/*` before assuming data loss |

---

## 14. Known operational limits (read before promising an SLA)

* **Single region.** Everything above assumes one host. There is no multi-region
  failover, no read replica, and no cross-region Redis.
* **Single bot writer by design** (§9) — you cannot scale trading horizontally.
* **`web` rolling restarts are not perfectly seamless** without the §10.2
  workaround; a brief 502 is possible while nginx points at a container that is
  going away.
* **Redis is on the critical path for authentication** (refresh-token store) and
  for IPN replay protection. A Redis outage signs users out and stalls IPN
  crediting until it is restored (`/healthz` will be 503 throughout).
* **No WAF, no DDoS protection, no CSRF token** beyond SameSite cookies, and no
  per-request audit of admin *reads* — see `SECURITY.md` for the full, honest
  list.
* **Backups are your responsibility** (§11); nothing in this repository performs
  or schedules them.
* **Migration history is forward-only.** There are no down migrations; plan
  rollbacks around expand/contract or a restore.
