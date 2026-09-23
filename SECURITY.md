# SECURITY.md — Autopipsz (autopips.pro)

Security posture of the Autopipsz platform, written from the code in this
repository. Every claim below cites the file that implements it. Where something
is **not** hardened, §8 says so plainly — this document is not marketing, and it
claims no certification, audit or penetration test (none has been performed).

Scope: the Next.js app (`src/app/**`), the standalone socket/bot runtime
(`src/server/**`), the Prisma data model (`prisma/schema.prisma`), and the
deployment artifacts (`Dockerfile*`, `docker-compose.yml`,
`deploy/nginx/autopips.pro.conf`).

---

## 1. Credential isolation

**Server-only environment.** The full environment contract lives in
`src/lib/env.ts` (zod schema) and is parsed **once per process** by
`serverEnv()`. The process refuses to start when anything is missing or
malformed:

```
Invalid or missing server environment variables:
  - JWT_SECRET: String must contain at least 32 character(s)
  …
```

The same module enforces the client-bundle boundary. This is the actual guard,
verbatim from `src/lib/env.ts`:

```ts
// Guard: a secret must never be exposed to the client bundle.
for (const key of Object.keys(parsed.data)) {
  if (key.startsWith('NEXT_PUBLIC_') && /SECRET|TOKEN|KEY|PASSWORD/i.test(key)) {
    throw new Error(
      `Refusing to boot: ${key} looks like a secret but is NEXT_PUBLIC_* and would leak to the browser.`,
    );
  }
}
```

Next.js inlines every `NEXT_PUBLIC_*` variable into the browser bundle, so this
guard turns "a secret was named wrong" into a boot failure instead of a silent
leak. `scripts/preflight.sh` runs the same check before a deploy.

> **Discrepancy (needs a code change, not a docs change):** the header comment of
> `src/lib/env.ts` says a `server-only` import guards the boundary. There is **no**
> `import 'server-only'` anywhere in the repository (verified: `rg "server-only" -g '!node_modules'`
> matches comments only). The enforced guards are the `NEXT_PUBLIC_*` check above
> and the fact that no client component imports `@/lib/env`. Adding
> `import 'server-only'` to `src/lib/env.ts` would make the boundary a build-time
> error instead of a convention — recommended, and reported here rather than
> changed (that file is owned elsewhere).

**Broker and payout credentials at rest.** `src/lib/crypto/credential-cipher.ts`
seals credentials that must be stored in Postgres with **AES-256-GCM**:

* key material from `CREDENTIAL_ENCRYPTION_KEY` (≥ 32 bytes; base64 or raw),
  purpose-separated via `sha256("autopips:<purpose>" || key)` so a token
  encrypted for the `metaapi` purpose cannot be decrypted as a `payout` secret;
* a **fresh 96-bit IV per encryption**, with the GCM authentication tag stored
  alongside;
* versioned wire format `v1.<iv>.<tag>.<ciphertext>` (base64url) so keys can be
  rotated without a flag day;
* `maskAccount()` keeps only the last four characters of an account id in
  logs/UI — never the full login.

MetaApi tokens are encrypted with `encryptCredential(token, 'metaapi')`
(`src/server/modules/broker/broker.registry.ts`); the SDK token is never logged,
never returned in an API response and never put into an error. NOWPayments
payout secrets are read from the environment only, and `scrub()` in
`nowpayments.client.ts` removes the API key, payout JWT and payout password from
any error string before it is thrown or logged.

**No secrets in the browser.** `src/lib/socket-client.ts` states and honours the
rule: the access token lives in an httpOnly cookie, the optional fallback socket
token is kept **in module memory only** (5–300 s, cleared on reload), and nothing
is ever written to `localStorage`. The socket handshake deliberately ignores a
token passed in the query string (it would leak into access logs). The nginx
config passes `x-nowpayments-sig` through unmodified and does not expose the
worker's internal publish endpoint (`/internal/publish` → 404).

**Internal channel.** `POST /internal/publish` on the worker requires
`Authorization: Bearer $WS_INTERNAL_TOKEN`, compared in constant time (both
sides SHA-256-hashed so `timingSafeEqual` cannot throw on a length mismatch and
the token length is not leaked). Rejections are logged **without** the token.
The endpoint is internal-only; the reverse proxy answers 404 for it.

---

## 2. Authentication and sessions

| Control | Implementation |
| --- | --- |
| Password hashing | **Argon2id** via `@node-rs/argon2`: `algorithm: Argon2id`, `memoryCost: 19456` KiB (19 MiB), `timeCost: 2`, `parallelism: 1`, PHC-format hashes — `src/server/modules/auth/password.service.ts` |
| Unknown-account timing | a dummy verification is burned when the email does not exist, so "no such user" and "wrong password" cost the same CPU |
| Access tokens | HS256 JWT signed with `JWT_SECRET`; `iss`/`aud` verified on every request; `alg` pinned to `['HS256']` (no `none`/algorithm-confusion path); 15 min default TTL — `src/server/modules/auth/token.service.ts` |
| Token transport | httpOnly, `SameSite=Lax`, `Secure` in production cookies `ap_at` / `ap_rt`; read from cookies only — never a query string, never `localStorage` |
| Refresh tokens | opaque `<sessionId>.<userId>.<token>`; **only** `sha256(token)` is stored, in Redis (`rkey('refresh-store', sessionId, userId)`), so a Redis dump cannot be replayed as a session |
| Rotation | every refresh consumes the stored hash and issues a new access+refresh pair (`consumeRefreshToken`) — single use |
| Replay response | a refresh token that does not match the stored hash, or is presented twice, revokes the whole **session family** (Redis `session:<sid>:revoked`), deletes the stored hash and clears cookies. `getSession()` and the socket handshake both honour revocation. Losing that session is the intended outcome — a refresh token that exists in two places cannot be trusted — `src/app/api/v1/auth/refresh/route.ts` |
| 2FA | TOTP (RFC 6238 via `speakeasy`, SHA-1, ±1 step ≈ ±30 s clock drift tolerance), issuer label from `TOTP_ISSUER`; a login with 2FA enabled issues a short-lived challenge (300 s) that must be completed out of band — `src/server/modules/auth/twofactor.service.ts` |
| Uniform credential errors | one message ("Invalid email or password.") for every credential failure — no account enumeration through the login response |
| Logout | audit-logged as `AUTH_LOGOUT`; revokes the session and clears both cookies |
| Password change | **not implemented.** `AUDIT.AUTH_PASSWORD_CHANGED` exists in the audit vocabulary (and in the activity label map) but **no code path records or performs it**, and there is no password-change or password-reset endpoint — a user's hash can only be replaced by direct database/seed intervention. See §8.3. |
| Session revocation | checked per request against Redis (`isSessionRevoked`) |

**Rate limiting** (`src/lib/rate-limit.ts`, Redis fixed window) — applied to the
abuse-prone endpoints, and it **fails closed** on a Redis outage so the limiter
cannot be bypassed by taking Redis down:

| Endpoint | Limit |
| --- | --- |
| `POST /api/v1/auth/login` | 10 / 900 s per IP **and** 10 / 900 s per email |
| `POST /api/v1/auth/register` | 5 / 900 s per IP |
| `POST /api/v1/auth/refresh` | 60 / 900 s per IP |
| `POST /api/v1/payments/deposits` | 10 / 300 s per user, 30 / 300 s per IP |
| `POST /api/v1/payments/withdrawals` | 5 / 600 s per user, 20 / 600 s per IP |
| `POST /api/v1/payments/nowpayments/ipn` | 120 / 60 s per IP |
| `POST /api/v1/kyc/upload` | 20 / 60 s per user |
| `POST /api/v1/account/investments` | 10 / 600 s per user |
| `POST /api/v1/contact` | 5 / 600 s per IP |

**Endpoints with no dedicated limiter** (covered only by session auth and the
proxy): `POST /api/v1/kyc/submit`, the read-only `/api/v1/account/**` routes and
every `/api/v1/admin/**` route. See §8.

**Edge middleware is not a security boundary.** `src/middleware.ts` checks only
the *presence* of the access cookie to decide a redirect; it never verifies it
(JWT verification needs the server-only key, which must not live at the edge).
Every API route and server component re-verifies through `requireSession()` /
`requireRole()` / `requireAdmin()`. The file says so in its own header comment.

---

## 3. Data protection

**KYC documents** (`src/server/modules/kyc/storage.service.ts`) — the only
sensitive documents the platform stores:

1. **Private S3 bucket only.** No public URL can be produced by the module; the
   only URL it can mint is a presigned `GetObject` URL. Requests that would grant
   public/anonymous access (canned ACLs such as `public-read`,
   `authenticated-read`, or grants to `AllUsers`/`AuthenticatedUsers`) are
   rejected by a client middleware guard.
2. **Encryption at rest is mandatory** on every PUT: SSE-KMS (`aws:kms` with
   `AWS_KMS_KEY_ID`) when configured, otherwise SSE-S3 (`AES256`). A caller cannot
   pass its own encryption parameters and cannot turn encryption off.
3. **Unguessable object keys**: `kyc/<userId>/<uuid>/<kind>-<uuid>.<ext>`, with
   the extension derived from the *validated* content type, never from the
   client-supplied filename.
4. **Presigned URLs are capped at 300 seconds** — a hard cap
   (`KYC_SIGNED_URL_TTL_HARD_CAP_SECONDS`) applied on top of
   `KYC_SIGNED_URL_TTL`, so a misconfigured deployment still issues 5-minute
   links. A presigned URL is a bearer credential for a passport scan; the cap is
   the blast-radius control.
5. **Every admin document read is audited**: `AUDIT.KYC_DOCUMENT_VIEWED` is
   written for each presigned URL issued.
6. **Input bounds**: 10 MB per document, four slots, allow-listed content types
   (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`), type+size
   asserted *before* any byte is uploaded and re-asserted inside the service so
   it cannot be bypassed. The platform has no third-party identity-verification
   API and does not claim to have one: documents leave the bucket only to a
   signed-in **admin** during manual review, whose decision is audited
   (`KYC_APPROVED` / `KYC_REJECTED` / `KYC_ADDITIONAL_INFO_REQUESTED`).

**Data minimisation in the database.** `prisma/schema.prisma` stores the KYC
*metadata* (`KycProfile`: legal name, DOB, address, id type/number) plus S3
object keys — never the document bytes. Withdrawals store a payout address;
broker credentials are ciphertext (§1). The refresh-token store is a SHA-256
digest in Redis.

**Transport.** TLS 1.2/1.3 only, HSTS `max-age=63072000; includeSubDomains;
preload`, HTTP→HTTPS redirect, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(self), microphone=(), geolocation=()` — set by both
`next.config.mjs` and `deploy/nginx/autopips.pro.conf` (the proxy copy covers
responses nginx generates itself). Postgres and Redis are not published off the
host; the app ports are bound to `127.0.0.1` and fronted by nginx.

---

## 4. Payment integrity

**Inbound (deposits).** `POST /api/v1/payments/nowpayments/ipn` is intentionally
unauthenticated — the HMAC signature *is* the authentication
(`src/server/modules/payments/ipn.service.ts`):

* `HMAC-SHA512(canonicalised_body, NOWPAYMENTS_IPN_SECRET)` compared against the
  `x-nowpayments-sig` header with `crypto.timingSafeEqual` (length guarded
  beforehand; the computed signature is never logged).
* Canonicalisation (`sortKeysDeep`) is deterministic and covered by
  `tests/ipn-hmac.test.ts` (25 cases: altered/added/removed fields, wrong
  length, wrong secret, non-JSON, arrays, key-order independence).
* The route hashes `await request.text()` — the **raw** body. `request.json()`
  would re-serialise and break every genuine signature, so body rewriting is
  forbidden at the proxy too (documented in the nginx config).
* **Replay guard**: `claimOnce('ipn:<paymentId>:<status>', 86400)` in Redis makes a
  duplicate delivery a no-op (the endpoint still ACKs 200 so the provider stops
  retrying). The guard **fails closed**: while Redis is unreachable every
  delivery is treated as already processed, so a Redis outage can lose a credit
  (recovered by the idempotent reconciliation path) but can never double-credit.
* **Status-driven crediting**: only `CONFIRMED`/`FINISHED` credit,
  `partially_paid` stays `PENDING`, `expired` becomes `FAILED`, and a credited
  deposit can never be walked back to an uncredited status
  (`regressionBlocked`). Every IPN outcome is audited
  (`DEPOSIT_IPN_RECEIVED` / `DEPOSIT_IPN_REJECTED` / `DEPOSIT_CONFIRMED` /
  `DEPOSIT_FAILED`).

**Outbound (withdrawals).** Payouts use the NOWPayments payout API, which is
JWT-authenticated rather than API-key-authenticated; credentials are supplied
**out of band** (`NOWPAYMENTS_PAYOUT_JWT`, or `NOWPAYMENTS_PAYOUT_EMAIL` +
`NOWPAYMENTS_PAYOUT_PASSWORD`) and are deliberately absent from the env schema.
When they are missing, `createPayout()` **fails loudly** instead of inventing
success: the withdrawal stays approved and an operator settles it manually and
records the `txHash`. The platform never fabricates a transaction hash and never
reports a payout that did not happen. A withdrawal cannot be re-requested against
capital that is already deployed (check-then-act is guarded, and both a per-user
and a per-IP limiter sit in front of the endpoint).

---

## 5. Accounting integrity

Money is `Decimal` (`src/lib/money.ts`), never floating point, and the equity
calculation has exactly **one** implementation: `src/server/accounting/equity.ts`
plus the pure assembler `buildEquityFromAggregates` in
`src/server/accounting/ledger.ts`. Every surface (client dashboard, admin,
exports) calls the same function — the model is:

```
deployedCapital   = Σ Investment.capitalUsd            (ACTIVE + PAUSED only)
credited          = Σ Deposit.amountUsd                (CONFIRMED + FINISHED only)
paidWithdrawals   = Σ Withdrawal.amountUsd             (FINISHED only)
startingCapital   = deployedCapital
confirmedDeposits = max(0, credited − deployedCapital)
netContributed    = credited − paidWithdrawals

equity = netContributed + realizedPnL + unrealizedPnL − deductedFees
```

Two wrong models are pinned against regression by `tests/integration-ledger.test.ts`:
double-counting investment capital *and* credited deposits, and double-debiting
withdrawals when the idle term is built from already-net capital. Realized P/L
comes only from `CLOSED` `TradeRecord.netPnL` rows — an open trade is never read
as realized profit — and `assertEquityConsistency` enforces the identity to the
cent. The suite (11 files / 199 tests) runs in CI both without a database (148
passed / 51 DB-backed skipped) and against a real Postgres 16 + Redis 7
(199 passed) — see `.github/workflows/ci.yml`.

Broker data is never synthetic: `src/no-fabricated-data` style static guards
(`tests/no-fabricated-data.test.ts`) fail the build on mock/simulated data in the
producer paths, and the MetaApi adapter copies broker-reported numbers verbatim
or returns null.

---

## 6. Operational controls that back these claims

* Non-root containers (`USER node`), no build secrets in image history (only
  `NEXT_PUBLIC_*` may be build args — stated in the `Dockerfile` header).
* `.env` is git-ignored **and** excluded from the Docker build context.
* `scripts/preflight.sh` refuses to deploy on placeholder secrets, short
  `JWT_SECRET`, a weak `CREDENTIAL_ENCRYPTION_KEY`, a secret-shaped
  `NEXT_PUBLIC_*` name, or unreachable Postgres/Redis — and never prints a value.
* Redis runs with append-only persistence because it holds the refresh-token
  store, the rate-limit buckets, the IPN replay guard and the bot single-writer
  lock (`autopips:lock:bot-runtime`).
* The bot is deliberately single-writer: two runtimes trading one master signal
  would double every client's exposure, so a second replica refuses to start its
  loop (`LOCK_HELD`).
* Immutable, append-only `AuditLog` rows for authentication, KYC, payments,
  investments and broker events; the admin UI exposes them at `/admin/audit`.
* CI (`.github/workflows/ci.yml`) fails on any type-check, lint, build or test
  error, on every push and pull request.

---

## 7. Responsible disclosure

Please report suspected vulnerabilities to **security@autopips.pro**
*(placeholder — replace with a monitored mailbox before launch)*.

* Include: affected component/URL, reproduction steps, impact, and any payloads.
* Please do **not** access other users' data, degrade the service, or run
  automated scans against production. Test against your own account.
* We aim to acknowledge within **3 business days** and to keep you updated as we
  triage. Please allow **90 days** before public disclosure, or less if a fix
  ships sooner.
* Encryption key for sensitive reports: *(placeholder — publish a PGP key or a
  `/.well-known/security.txt` before launch)*.
* No bug bounty is offered, and we cannot pay for reports.

---

## 8. Known limitations / not yet hardened

Honest list, derived from reading this codebase. None of these is a hidden
surprise in the implementation; they are simply not done.

**Application**
1. **No CSRF token.** State-changing requests are protected only by
   `SameSite=Lax` + httpOnly cookies and by requiring JSON bodies. There is no
   double-submit token and no `Origin`/`Sec-Fetch-Site` assertion. `Lax` blocks
   cross-site POSTs in modern browsers, but this is a single layer — a
   same-site/subdomain-origin attack or a non-enforcing client is not covered.
2. **No `Content-Security-Policy` anywhere.** `next.config.mjs` sets
   X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy and HSTS — but
   no CSP, no `frame-ancestors`, no SRI on any script. XSS mitigation rests on
   React's escaping and the absence of `dangerouslySetInnerHTML` in the audited
   paths.
3. **No email verification, no password reset, and no password change.** `User`
   has no `emailVerified` field; anyone can register with any address, there is no
   self-service recovery (an operator must intervene), and `AUTH_PASSWORD_CHANGED`
   is an unused audit label with no endpoint behind it. A user who forgets or
   suspects compromise of their password cannot rotate it themselves. This also
   means a notification address is unverified for every account.
4. **TOTP secrets are stored unencrypted** (`User.twoFactorSecret` in plaintext
   in Postgres). The AES-256-GCM credential cipher exists and is used for broker
   and payout credentials; applying it to `twoFactorSecret` is a small, pending
   change.
5. **2FA is opt-in for everyone, including admins.** Nothing forces an
   `ADMIN` or `TRADING_MANAGER` account to enrol in TOTP before using the admin
   API.
6. **No per-request audit of admin *reads*.** Admin list/detail endpoints are not
   audited; the audited admin actions are the decisions/writes (KYC decisions,
   withdrawal decisions, plan/broker changes) plus KYC document *views*. A
   compromised admin session can enumerate users and ledgers without leaving a
   trail beyond normal access logs.
7. **Session revocation fails open when Redis is down** (`isSessionRevoked`
   returns `false` on a Redis error). A revoked session would be honoured for up
   to the remaining access-token TTL (≤ 15 min) during a Redis outage. This is a
   deliberate availability trade-off with a bounded blast radius, not an
   oversight — but it is a trade-off.
8. **Rate limiting fails closed**, so a Redis outage makes login/register/refresh
   return 429 rather than degrade. Availability and abuse-resistance were ranked
   above "keep signing people in" here; it means Redis is a single point of
   denial for authentication.
9. **The rate limiter is per-process/fixed-window with no global backoff or
   account lockout.** Distributed floods from many IPs are not mitigated, and
   the following mutating endpoints have **no** dedicated limiter at all:
   `POST /api/v1/kyc/submit` (a submission can carry four 10 MB documents — the
   upload endpoint is limited, the submission endpoint is not) and every
   `/api/v1/admin/**` route.
10. **No WAF, no bot detection, no DDoS protection, no IP allow-list for
    `/admin`.** Registration abuse is bounded only by 5 requests / 15 min / IP.
11. **No data-retention or deletion automation.** There is no purge job for
    closed accounts, expired KYC documents, or old `AuditLog` rows; retention is
    whatever an operator does by hand.
12. **Payout credentials are long-lived and coarse.** The pre-minted
    `NOWPAYMENTS_PAYOUT_JWT` has no automated rotation, and the email/password
    variant means a NOWPayments account password lives in the worker's
    environment. A leak of either allows payouts from the treasury wallet; there
    is no per-transaction approval service.
13. **`/internal/publish` is protected by a single shared static bearer token**
    (`WS_INTERNAL_TOKEN`) — no scoping, no expiry, no rotation mechanism. It is
    not exposed publicly (nginx 404s it), which is the compensating control.
14. **`npm audit` is disabled** in this repository (`.npmrc` sets
    `audit=false`) and there is no Dependabot/Renovate configuration or
    dependency-scanning job in CI. Dependency vulnerabilities would not be
    surfaced automatically.
15. **No `import 'server-only'` guard** on `src/lib/env.ts` (see the note in §1),
    so the "this module is server-only" rule is a convention enforced by review,
    not by the compiler.
16. **Logs are not PII-scrubbed centrally.** Audit rows store user ids, actions
    and IP addresses by design; application logs may contain emails and account
    ids. There is no redaction policy or log retention limit configured here.
17. **No logging/monitoring/alerting stack.** No SIEM, no anomaly detection, no
    alert on repeated `AUTH_LOGIN_FAILED` or `DEPOSIT_IPN_REJECTED` bursts — an
    operator has to look.

**Infrastructure**
18. **Single region, single host.** No multi-region failover, no Postgres read
    replica, no Redis cluster, no tested disaster-recovery drill.
19. **No secret manager integration.** `.env` on the host (mode 600) or compose
    `env_file`; Vault/Secrets Manager wiring is not in place, and
    `CREDENTIAL_ENCRYPTION_KEY` rotation has no automation (the versioned
    `v1.<iv>.<tag>.<ct>` format allows it, but nothing re-encrypts existing
    rows).
20. **Backups are manual.** No scheduled `pg_dump`, no off-box replication, no
    restore drill in this repository (see `DEPLOYMENT.md` §11).
21. **No third-party penetration test, no SOC 2 / ISO 27001 / PCI attestation,
    and no certification of any kind.** This platform holds no card data (all
    fiat/crypto movement is through NOWPayments), which is a design choice, not
    an audit result.
22. **n8n/CI secrets are unscoped.** The CI workflow uses only dummy values, but
    any real deployment pipeline needs its own secret handling; nothing here
    provisions that.

---

Source of truth for every claim above is the code in this repository; if a
future change contradicts this document, the code wins and this file must be
updated in the same pull request.
