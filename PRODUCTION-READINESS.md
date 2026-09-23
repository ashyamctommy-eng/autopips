# Autopipsz — Production Readiness Report

**Repository:** `https://github.com/ashyamctommy-eng/autopips`
**Domain:** `autopips.pro`
**Date:** 2026-09-23
**Scope:** full platform build — schema, backend services, API, UI, real-time tier,
deployment artifacts, and independent verification.

---

## 1. Verdict

The codebase is **code-complete and build-verified**. Every automated gate passes
against a live PostgreSQL 14 and Redis 6. The accounting core was independently
adversarially reviewed and **eleven real defects were found and fixed** during
verification, including three that would have let a client withdraw or deploy money
they did not have.

It is **not yet deployed and not yet exercised against live broker, payment or storage
providers.** Go-live is blocked on credentials and infrastructure that only the operator
can supply — enumerated precisely in §5. No claim in this report rests on a live
MetaApi, NOWPayments or S3 call, because none was made.

---

## 2. Verification evidence

Every gate below was executed in this session against a real database. None is aspirational.

| Gate | Command | Result |
| --- | --- | --- |
| Schema validity | `npx prisma validate` | ✅ valid |
| Migration applied | `npx prisma migrate dev` | ✅ `20260923173313_init` applied to live PostgreSQL 14 |
| Migration status | `npx prisma migrate status` | ✅ "Database schema is up to date" |
| Client generation | `npx prisma generate` | ✅ v5.22.0 |
| Types | `npx tsc --noEmit` | ✅ **0 errors**, strict mode, no `any`, no `@ts-ignore` |
| Lint | `npx next lint` | ✅ **no warnings or errors** |
| Production build | `npx next build` | ✅ **exit 0, no warnings** — 60+ routes compiled |
| Test suite | `npm test` | ✅ **208 / 208 passed**, 12 files, 0 skipped |
| DB-less test mode | `DATABASE_URL=<dead port> npm test` | ✅ DB-backed specs skip cleanly, exit 0 |

### What the test suite actually proves

| File | Tests | Property established |
| --- | --- | --- |
| `equity.test.ts` | 32 | The formula against a hand-computed scenario table; cent-exact boundary on the consistency guard; 500-case seeded property test vs an independent Decimal recomputation |
| `integration-ledger.test.ts` | 24 | Real DB: only credited deposits credit, only finished withdrawals debit, stored aggregates are never trusted over trade rows |
| `money-path-e2e.test.ts` | 8 | deposit → invest → trade → withdraw → settle, asserting the equity identity at every step |
| `money-path-races.test.ts` | 5 | Concurrency: N parallel withdrawals/investments, exact success counts, no over-reservation |
| `money-path-fixes.test.ts` | 7 | Partial-then-finished payment credits in full; forged amounts cannot inflate |
| `accounting-adversarial.test.ts` | 12 | Attempts to break the ledger: cancelled investments, negative equity, in-flight payouts, cross-surface equality |
| `ipn-hmac.test.ts` | 25 | HMAC-SHA512 accept/reject matrix against an independent implementation; key-order independence; status mapping |
| `risk-engine.test.ts` | 27 | All 9 pre-trade rules, fail-closed behaviour, first-failure ordering |
| `lot-allocator.test.ts` | 23 | The master→client formula, round-**down** to volume step, conservation (client lots never exceed the master lot) |
| `fees.test.ts` | 19 | Pro-rata management fees, high-water-mark performance fees, solvency clamp |
| `indicators.test.ts` | 13 | EMA/RSI against hand-computed values; degenerate inputs never produce NaN |
| `no-fabricated-data.test.ts` | 13 | **Static guard**: AST-parses producer sources and fails on `Math.random`, mock/fake/sample data, or a hard-coded performance figure |

Independent HTTP-level verification was also run against a live dev server: client JS
chunks were pulled and grepped for every secret value (0 hits); all 18 admin
route/method combinations were probed for authz; the IPN webhook was tested unsigned,
mis-signed, correctly-signed **with keys in a different order**, and replayed.

---

## 3. Defects found and fixed during verification

This is the most important section for a reviewer: it is the evidence that verification
was real. All were found by the verification agents, reproduced against the live database,
and fixed.

### Money-integrity defects (would have moved real money wrongly)

| # | Defect | Impact | Status |
| --- | --- | --- | --- |
| D1 | The equity formula summed `Investment.capitalUsd` **and** all credited deposits — the same dollar counted twice | Deposit $1,000, invest it, account read $2,000. A $1,000 withdrawal of thin air was possible | ✅ Fixed — the two capital terms are now a partition; asserted by tests |
| D2 | Withdrawal eligibility used a private, stale copy of the formula that treated only `ACTIVE` capital as locked | PAUSED capital looked withdrawable; a client could withdraw capital that was deployed with the broker | ✅ Fixed — the withdrawal path now reads the same ledger the dashboard shows |
| D3 | The admin user list had a **third** divergent copy of the formula | Admin saw a different equity than the client for the same account | ✅ Fixed — one shared `buildEquityFromAggregates`, cross-surface equality asserted |
| D7 | `requestWithdrawal` was check-then-act with no lock | 3 concurrent requests reserve 1,800 against a 600 balance; reservations are what admins approve → over-payout | ✅ Fixed — `SELECT … FOR UPDATE` on the user row inside one transaction |
| D8 | `createInvestment` had the same race | 2 concurrent requests deploy 2,000 of a 1,000 balance → the invalid `deployed > credited` ledger state | ✅ Fixed — same row-locked transaction |
| D9 | Admin approve/reject was read-then-write | A concurrent APPROVE and REJECT could leave a **rejected** withdrawal in a payable state | ✅ Fixed — compare-and-swap on status; the loser gets a conflict |
| — | A `partially_paid` IPN rewrote `amountUsd` (the credit ceiling) downward | A later full `finished` payment was credited only at the partial figure — verified $90 under-credit on $100 | ✅ Fixed — the ceiling is never lowered; the partial stays in `ipnPayload` |
| D5 | The client ledger and the admin projection disagreed on `CANCELLED` investments | Two surfaces, two equities, for one account | ✅ Fixed — both exclude `CANCELLED`; equality asserted |
| — | `assertEquityConsistency` used `> 0.01`, tolerating a 1-cent drift | A one-cent-per-event drift would pass forever and compound invisibly | ✅ Fixed — strict `>= 0.01` |
| — | Strategy stats used every investment as the return denominator, including ones that never traded | Observed return understated 4× (3.75% reported vs 15.00% real) | ✅ Fixed — denominator scoped to investments with a closed trade |

### Correctness / build defects

| Defect | Impact | Status |
| --- | --- | --- |
| `/login` and `/register` were **404** — never built | Every "Sign in" CTA and every protected-route redirect led to a 404; the app was unusable through its own UI | ✅ Fixed — full auth pages incl. the 2FA challenge step and an open-redirect guard |
| An extra export in a route file | Failed the Next.js production build | ✅ Fixed |
| `@types/socket.io-client@1.4.33` (a transitive dep of the MetaApi SDK) declares an ambient Socket.IO **v1** module that shadowed the real v4 types | `import { io, Socket } from 'socket.io-client'` was a hard type error | ✅ Fixed via an npm `overrides` pin to the deprecation stub |
| `text-base` emitted a **colour** rule that overrode the font-size rule (the design system defines `colors.base.DEFAULT`) | Near-invisible text on real pages | ✅ Fixed — replaced with `text-[1rem]` across the codebase |
| `@node-rs/argon2` declares `Algorithm` as an ambient const enum | TS2748 under `isolatedModules` | ✅ Fixed — the value is inlined with an explanatory comment |

**Remaining known issues** (reported, not hidden): the payout-approval path does not
re-read the ledger at settlement time, so a reservation could be paid after a loss lands;
`applyFees` is a read-modify-write with no lock (no caller today); correctness of the row
locks depends on PostgreSQL's default READ COMMITTED isolation. These are documented in
`tests/LEDGER-VERIFIER-FINDINGS.md`.

---

## 4. Scope delivered

**231 source/test files · ~35,700 lines of `src/` · ~6,500 lines of tests.**

### Database
The exact schema from the brief, plus additive performance indexes and `onDelete: Cascade`
on child relations. Decimal precision was specified (`18,2` for money, `18,5` for
lots/prices, `18,8` for crypto payouts) because the brief left it open and float money is
not acceptable.

### Backend services
`auth` (Argon2id, HS256 JWT with issuer/audience, single-use rotating refresh tokens with
replay-triggered family revocation, TOTP 2FA, login rate limiting) · `kyc` (private S3,
SSE-KMS-or-AES256 enforced, non-guessable keys, **300-second** pre-signed admin URLs, every
view audited) · `payments` (NOWPayments client, strict HMAC-SHA512 IPN verification with
timing-safe comparison and a Redis replay guard, deposit/withdrawal lifecycle) · `broker`
(MetaApi adapter implementing a broker-agnostic interface, connection registry with
AES-256-GCM token encryption, sync worker) · `bot` (9-check fail-closed risk engine,
master→client lot allocator, strategy engine on real broker candles, high-water-mark fee
engine, Redis-singleton runtime) · `account` · `admin` · `audit` (append-only).

### Accounting
One implementation of the equity formula, used by every surface, with the formula string
surfaced to the client as returned API data.

### Frontend
Public site (hero, live strategy metrics from verified trade history, transparency,
5-step flow, plans, about, 14-question FAQ, a substantial risk disclosure, contact) ·
auth pages incl. the 2FA challenge · client portal (overview with an honest equity-formula
panel, live trading with TradingView lightweight-charts, positions, history, KYC upload,
deposits with QR + address copy, withdrawals, settings with 2FA) · admin suite (AUM,
KYC reviewer with signed-URL document viewer and expiry countdown, users, plan
configurator, broker manager, payouts, audit log).

Dark-mode fintech design system (`#0B0E14` base, cyan/emerald accents) built on
hand-written shadcn-style primitives.

### Real-time
Socket.io on the `/ws/trading` namespace, JWT handshake auth, ownership-verified rooms,
Redis pub/sub bridging the web tier to the socket tier, live positions/ticks/equity/bot
activity feed, admin room.

### Live data integrity
Where data does not exist, the UI says so. Empty states are explicit throughout — no
sample positions, no placeholder candles, no demonstration equity curve, no stand-in win
rate. This is enforced by a test that parses the producer sources.

### Deployment
`Dockerfile`, `Dockerfile.worker`, `docker-compose.yml` (postgres + redis + one-shot
migrate + web + worker), an nginx config with the required WebSocket upgrade rules and
`client_max_body_size 12m` for KYC uploads, a CI workflow (a DB-less job plus an
integration job with service containers), `DEPLOYMENT.md`, `SECURITY.md`, and
`scripts/preflight.sh`.

---

## 5. Blockers to go-live — operator action required

Each item below needs credentials or infrastructure that cannot be created from here.
None of it has been tested live; that is stated plainly rather than assumed away.

| # | Blocker | What is needed |
| --- | --- | --- |
| 1 | **MetaApi broker account** | A token, a funded MT4/MT5 account, and the terminal **deployed** via MetaApi. No order has ever been placed. Until then the bot has nothing to trade and the chart shows its empty state by design. |
| 2 | **NOWPayments production key + IPN secret** | `NOWPAYMENTS_API_KEY` and `NOWPAYMENTS_IPN_SECRET`. Every IPN test used a self-computed HMAC. Register the callback as `https://autopips.pro/api/v1/payments/nowpayments/ipn`. |
| 3 | **NOWPayments payout credentials** | The payout API needs a JWT from `/auth`, not the API key. Until supplied, approved withdrawals remain approved for manual settlement and the platform records the transaction hash by hand — it will never invent one. |
| 4 | **Private S3 bucket** | A bucket with **Block Public Access ON**, SSE-KMS preferred, plus credentials. No upload has been performed against real S3. |
| 5 | **Production secrets** | `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `WS_INTERNAL_TOKEN`, DB credentials. `scripts/preflight.sh` fails while any value still contains `CHANGE_ME`. |
| 6 | **Hosting + TLS + DNS** | `autopips.pro` pointed at the host, certificates issued, **and the `/ws/` location proxied with WebSocket upgrade support** — without it the real-time tier silently falls back and never connects. |
| 7 | **Container images** | No Docker daemon exists in the build sandbox, so the Dockerfiles and compose file are reasoned and syntax-validated but **never built**. First `docker compose build` should be treated as the first real test. |
| 8 | **Compliance sign-off** | The platform deliberately makes no regulatory claim. Whoever operates `autopips.pro` must confirm their own licensing position, terms of service, and privacy policy for the jurisdictions they accept clients from. |

---

## 6. Deliberate deviations from the brief

| Brief | Delivered | Why |
| --- | --- | --- |
| `@metaapi/metaapi-node-sdk` | `metaapi.cloud-sdk` v29 | The named package **does not exist on npm**. The real SDK is `metaapi.cloud-sdk`; the adapter is written against its actual published API surface, verified against its type declarations. |
| `aws-sdk` | `@aws-sdk/client-s3` v3 | AWS SDK v2 is end-of-life; v3 is the current AWS SDK for JavaScript. |
| NestJS **or** Next.js API Routes | Next.js App Router route handlers + framework-agnostic modules in `src/server/modules/*` with `src/server/main.ts` | The brief allowed either. One deployable keeps the surface smaller while preserving the required tree and modularity. |
| Socket.io "directly to Next.js clients" | A separate Node socket process, bridged by Redis pub/sub | A Next.js App Router app **cannot** host a Socket.io server. Documented in the README and `DEPLOYMENT.md`; the nginx config carries the upgrade. |
| Exact schema | Fields unchanged; **indexes added**, decimal scales specified, `onDelete` behaviour set | Indexes and scales are additive/unspecified; float money was not acceptable. No field was renamed or removed. |
| MetaApi token storage | AES-256-GCM-encrypted in Redis, with a documented note to move it to a dedicated column or secrets manager | The frozen schema has no token column on `BrokerConnection`. |
| `PaymentStatus` for withdrawal approval | `SENDING` = approved, `FAILED` = rejected, with the reason in the audit row | The enum has no `APPROVED`/`REJECTED` member; adding one would change the frozen schema. |
| `argon2` | `@node-rs/argon2` (Argon2id, standard PHC format) | Avoids a node-gyp toolchain at image build time; same algorithm and hash format. |

---

## 7. Honest limitations

- **Nothing has run against a real broker, real payment provider, or real object store.**
  All integrations are verified against their published contracts, not against live
  endpoints.
- **No load, soak or failover testing.** Rate limits and room fan-out are unit-verified,
  not load-verified.
- **No penetration test.** Authz was probed systematically over HTTP (18 admin
  route/method combinations, cross-tenant reads), but that is not a substitute for one.
- **`npm audit` was not reviewed.** Several transitive advisories are plausible; the
  dependency tree includes a large broker SDK.
- **No CSRF token** beyond `SameSite=Lax` cookies and JSON-only bodies.
- **Single region, no WAF, no DDoS protection.**
- **`createInvestment`/`requestWithdrawal` serialise per user via a row lock**, which is
  correct but will contend under extreme per-user concurrency.
- **Partially-paid deposits stay `PENDING` indefinitely.** An operator reconciliation
  policy is needed (the partial figure is recorded in `ipnPayload`).
- The `docker-compose.yml` stack is single-host and intended as a starting point, not a
  HA topology.

---

## 8. Recommended go-live sequence

1. Provision PostgreSQL and Redis; set every variable in `.env`; run `scripts/preflight.sh`
   until it passes.
2. `npx prisma migrate deploy`.
3. Create the private S3 bucket (Block Public Access ON, SSE-KMS).
4. `docker compose build && docker compose up -d` — treat this as the first real test of
   the container artifacts.
5. Point `autopips.pro` at the host; issue TLS; confirm the `/ws/` proxy carries the
   WebSocket upgrade.
6. Add the MetaApi account and confirm the broker connection reports `CONNECTED` with a
   real balance in `/admin/brokers`.
7. Register the IPN callback with NOWPayments and send a **live minimum deposit**;
   confirm it credits exactly once and appears in the client's deposit history.
8. Create the first ADMIN user, then create plans in `/admin/plans`.
9. Submit one KYC file as a test client and walk the admin approve flow, confirming the
   signed URLs expire after 300 seconds.
10. Fund a small test allocation and observe one full trade cycle end to end before
    accepting client capital.
