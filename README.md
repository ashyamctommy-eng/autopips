# Autopipsz — autopips.pro

Managed algorithmic trading platform. Client capital is mirrored onto **Deriv**
accounts through Deriv's WebSocket API
(`wss://api.derivws.com/trading/v1/options/ws/public` for public market data, and
a per-account OTP-issued socket for trading — Deriv retired the old `ws.derivws.com`
host, which now answers Cloudflare 520 to every request),
settlements run through **NOWPayments.io**, and every figure the platform reports is
derived from a persisted, verified record.

> **Targets shown anywhere in this product are `Target/Indicative — non-guaranteed`.**
> They are strategy objectives, not promises. Capital is at risk of loss.

---

## What this is

A production-shaped platform with four surfaces:

| Surface | Route | Purpose |
| --- | --- | --- |
| Public site | `/`, `/strategies`, `/plans`, `/about`, `/faq`, `/risk`, `/contact` | Strategy disclosure, live verified metrics, risk disclosure |
| Auth | `/login`, `/register` | Argon2id passwords, optional TOTP 2FA |
| Client portal | `/dashboard` | Equity, live trading, positions, history, KYC, deposits, withdrawals |
| Admin suite | `/admin` | AUM, KYC review, users, plans, broker connections, payouts, audit log |

---

## Non-negotiable engineering directives

These are enforced in code, not just documented. Where a rule is mechanical, the
enforcing file is named so a reviewer can check it.

1. **Zero simulation.** Every trade, balance change and P/L figure originates from a
   verified NOWPayments IPN callback, a Deriv broker event, or an admin action that
   wrote an audit row. There is no `mockMode`, no seed data, no fallback constant
   anywhere on a producer path. A static guard test (`tests/no-fabricated-data.test.ts`)
   parses the producer sources and fails if `Math.random`, mock/fake/sample data, or a
   hard-coded performance figure is introduced.
2. **No guaranteed returns.** The label lives in one place
   (`TARGET_RETURN_LABEL` in `src/lib/contracts.ts`) and the UI renders target ranges
   exclusively through the `TargetRange` compliance component, which cannot be
   configured to omit the caveat.
3. **Accounting integrity.** See the formula below; implemented exactly once in
   `src/server/accounting/`.
4. **Credential security.** Secrets are server-only. `src/lib/env.ts` **refuses to boot**
   if a secret-looking variable is named `NEXT_PUBLIC_*`, because that prefix is inlined
   into the browser bundle. Broker tokens are encrypted at rest with AES-256-GCM
   (`src/lib/crypto/credential-cipher.ts`). Nothing is ever written to `localStorage`.
5. **Manual KYC.** No third-party identity API. Documents are uploaded by the client,
   encrypted at rest with AES-256-GCM, and stored in the platform's own PostgreSQL
   (`KycDocument.ciphertext`). The only read path is an ADMIN-authenticated, audited route
   that streams the decrypted bytes to a reviewer, who approves or rejects by hand — every
   view is written to the audit log.
6. **Strict payment verification.** The IPN webhook verifies an HMAC-SHA512 signature
   over the key-sorted raw body, compares it in constant time, and de-duplicates via a
   Redis replay guard.

---

## Accounting integrity

```
Equity = Starting Capital
       + Realized P/L
       + Unrealized P/L
       - Deducted Fees
       - Withdrawals
       + Confirmed Deposits
```

The two additive capital terms are a **partition** of contributed capital, not two
overlapping sums:

- **Starting Capital** — capital currently *deployed* with a strategy
  (`Σ Investment.capitalUsd` where status ∈ {ACTIVE, PAUSED})
- **Confirmed Deposits** — confirmed deposits *not yet deployed*
  (`Σ credited deposits − deployed capital`)

Substituting reduces the formula to the standard managed-account identity:

```
Equity = (credited deposits − paid withdrawals) + Realized P/L + Unrealized P/L − Fees
```

Consequences that are asserted by tests:

- Depositing and then investing is **equity-neutral** — only the split between the two
  buckets changes.
- Closing an investment returns its capital to idle and leaves equity untouched.
- You cannot deploy or withdraw capital you have not contributed; `withdrawableBalance`
  is the single authority for both.
- `equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees`, always,
  to the cent.

There is exactly **one** implementation of this arithmetic
(`buildEquityFromAggregates` in `src/server/accounting/ledger.ts`). The client overview,
the admin AUM dashboard, the admin user list and withdrawal eligibility all call it, and
a test asserts all three surfaces report the same number for the same account.
Money maths uses `decimal.js` throughout — never IEEE-754 floats.

---

## Architecture

```
Next.js 14 (App Router)  ──┐
  • public / dashboard / admin pages (server components read services directly)
  • /api/v1/* route handlers                 │
                                            ├──> PostgreSQL (Prisma)  — system of record
Socket.io worker  ──────────┐               ├──> Redis  — sessions, rate limits, replay guard,
  • src/server/main.ts      │               │            socket pub/sub, bot singleton lock
  • /ws/trading namespace   └──> Redis pub/sub ──┘
  • bot runtime + broker sync               └──> Deriv WS API ──> Deriv contracts
                                            └──> NOWPayments.io
```

Why two processes: a Next.js App Router app cannot host a Socket.io server. The socket
server and the bot runtime run as a standalone Node process (`src/server/main.ts`) and
communicate with the web tier over **Redis pub/sub**, so any replica can publish a live
event and the socket tier fans it out to authorised rooms. The bot runtime takes a Redis
lock, so only one instance trades at a time.

### The three worker runtimes

The worker process is a supervisor, not a monolith: `src/server/main.ts` starts each
runtime below and restarts it if it stops on its own.

| Runtime | Responsibility | Why it is its own loop |
| --- | --- | --- |
| `bot-runtime` | strategy evaluation, the signal → order path, fee accrual, broker sync | takes the Redis single-writer lock `autopips:lock:bot-runtime`, so exactly one instance ever trades |
| `maturity-runtime` | releases principal when a plan term ends | a halted platform must still return capital on time |
| `exit-watch` | one public price subscription per symbol with an **OPEN position**, so stop-loss and take-profit levels are evaluated with no client watching | pausing strategy generation must never pause the exits |

### Market data (hybrid feed)

Two feeds, routed **per instrument** (`providerForSymbol`):

- **Twelve Data** — historical candles for FX, metals, crypto and the commodities it
  carries, when `MARKET_DATA_PROVIDER=twelve`.
- **Deriv public WS** — live ticks, plus everything Twelve Data does not carry: synthetic
  indices (`R_10`, `R_100`), unmapped symbols, and instruments the current Twelve Data
  plan cannot price.

Live ticks are always Deriv, and **order fills follow the tick feed** rather than the
candle provider: a client is shown a Deriv price, so pricing their fill from another
vendor's one-minute candle would hand them a fill they never saw. Turning
`MARKET_DATA_PROVIDER=twelve` on is therefore safe for every listed instrument — a
synthetic or unmapped symbol simply keeps using Deriv — while a mapped symbol the vendor
fails to serve is a loud failure, never a silent substitution.

### Internal execution

`EXECUTION_MODE` (default `internal`) books client trades on the platform's own ledger
instead of sending them to a broker: a `Position` row holds the stake (the money at risk)
and the multiplier (the exposure), marked from the price feed, with its own stop loss and
take profit. The stake is reserved out of withdrawable cash, so opening a position is
equity-neutral. `broker` restores the previous path, and internal positions are refused
outright while it is set.

Broker-routed trades and internal positions are **different tables** — `TradeRecord` (per
investment, per broker connection) and `Position` (per user) — and the dashboard shows
both, because both are real money.

### Modules

```
src/
├── app/
│   ├── (public)/            marketing + risk disclosure
│   ├── (auth)/              login, register, 2FA challenge
│   ├── dashboard/           client portal
│   ├── admin/               admin control suite
│   └── api/v1/              REST surface (see below)
├── components/              ui/ shared/ charts/ layout/ + feature folders
├── lib/                     env, prisma, redis, money, http, contracts, crypto, socket client
├── server/
│   ├── accounting/          equity.ts · ledger.ts · strategy-stats.ts
│   ├── modules/
│   │   ├── auth/            Argon2id, JWT sessions, TOTP 2FA
│   │   ├── kyc/             internal encrypted store, admin review
│   │   ├── payments/        NOWPayments client, IPN verification, deposits, withdrawals
│   │   ├── broker/          Deriv client + adapter (public feed, OTP account sockets), registry
│   │   ├── bot/             strategies, risk engine, stake allocator, order manager, fees
│   │   ├── market/          hybrid feed: public ticks, Twelve Data candles, quote fan-out, exit watch
│   │   ├── positions/       internal engine: open/close, mark-to-market, stops/targets, wallet
│   │   ├── settings/        console settings: definitions, validation, per-process cache
│   │   ├── account/         client account service
│   │   ├── admin/           admin service
│   │   └── audit/           append-only audit logger
│   ├── ws/                  event bus, socket server
│   └── main.ts              socket server + runtime supervisor (bot, maturity, exit watch)
└── middleware.ts            coarse route protection (presence check only)
```

### API surface

```
POST   /api/v1/auth/register | login | refresh | logout
       /api/v1/auth/2fa/challenge | setup(GET) | enable | disable
GET    /api/v1/auth/me | socket-token

GET    /api/v1/plans                          (public)
GET    /api/v1/account/overview | investments | positions | trades | activity
POST   /api/v1/account/investments

POST   /api/v1/kyc/upload                     (multipart, up to 2 documents)
POST   /api/v1/kyc/submit
GET    /api/v1/kyc/me

GET    /api/v1/payments/deposits | withdrawals | currencies
POST   /api/v1/payments/deposits | withdrawals
POST   /api/v1/payments/nowpayments/ipn       (HMAC-authenticated webhook)

GET    /api/v1/market/candles

GET    /api/v1/wallet                         derived from the ledger — no balance column
GET    /api/v1/positions                      the internal book (open, closed, all)
POST   /api/v1/positions                      open one — server-priced fill, KYC-gated
POST   /api/v1/positions/:id/close            close at the current market price

GET    /api/v1/admin/overview | aum | users | plans | brokers | withdrawals | logs
PATCH  /api/v1/admin/users/:id | plans/:id
POST   /api/v1/admin/plans | brokers | brokers/:id/status | withdrawals/:id/decision
GET    /api/v1/admin/brokers/:id/status
DELETE /api/v1/admin/brokers/:id
GET    /api/v1/admin/kyc | kyc/:id | kyc/:id/files
POST   /api/v1/admin/kyc/:id/decision
```

Every route returns a uniform envelope — `{ ok: true, data }` or
`{ ok: false, error: { code, message, details } }` — and validates input with zod.

### Realtime channels

Socket.io namespace `/ws/trading`, engine.io path `/ws/socket.io`. The handshake uses the
session cookie, or a short-lived token (`GET /api/v1/auth/socket-token`) when the worker
is on a different origin.

```
client -> server   trading:subscribe | trading:unsubscribe     investment room
                   market:<symbol>                             public price room

server -> client   trade:opened | trade:updated | trade:closed position deltas
                   price:tick                                  public quotes, filtered by symbol
                   account:equity                              equity roll-ups
                   bot:activity                                audit-backed activity stream
                   broker:status | admin:system_status          operational state
                   server:error                                protocol / authorisation errors
```

Rooms: `user:<userId>` — joined automatically for the authenticated socket, which is why
account-wide `bot:activity` arrives without subscribing to anything; `trading:<investmentId>`
— joined only after an ownership check; `market:<symbol>` — public prices, capped per
socket; `admin` — privileged roles only.

---

## Local development

**Prerequisites:** Node 20+, PostgreSQL 14+, Redis 6+.

```bash
git clone https://github.com/ashyamctommy-eng/autopips.git
cd autopips
npm install
cp .env.example .env          # then fill it in
npx prisma migrate dev        # create the schema
npx prisma generate
npm run dev                   # web      → http://localhost:3000
npm run dev:ws                # socket + bot runtime → http://localhost:4001
```

`npm run dev` alone gives you the full UI; the second process is needed for live P/L,
price ticks and the bot activity feed.

### Verification

```bash
npm run typecheck     # tsc --noEmit
npm run lint
npm test              # vitest — unit + live-DB integration
npm run build         # production build
npx prisma validate
bash scripts/preflight.sh   # pre-deployment environment check
```

The database-backed tests **skip gracefully** when no database is reachable, so `npm test`
is safe in CI without infrastructure; when Postgres and Redis are present they run for real.

---

## Operating the platform

- **A client cannot move money before a human approves their KYC.** Deposits,
  investments and withdrawals all require `kycStatus = APPROVED`.
- **Deposits credit only on a verified IPN** in a credited status (`CONFIRMED`,
  `FINISHED`). `partially_paid` and `expired` never credit, and a forged or replayed
  callback can never inflate a balance — the credited amount is capped by the requested
  amount and the provider's own `price_amount`.
- **Withdrawals are a two-step, audited flow.** A client reserves a payout (subject to
  `withdrawableBalance`); an admin approves it. Payout credentials are configured
  out-of-band, and when they are absent the row stays approved for manual settlement —
  the platform never fabricates a transaction hash.
- **The bot is fail-closed.** Nine pre-trade checks (account active, broker connected,
  duplicate signal, equity floor, drawdown, open-position cap, per-order cap, symbol
  tradable, available capital) run before any order. A check that cannot be evaluated is
  a rejection. Client allocation is scaled by `Client Investment Capital / Master Account
  Equity` and only ever rounded **down** — the conservation property (a client is never
  granted more exposure than the ratio allows) is asserted by `tests/lot-allocator.test.ts`.
- **Trades are booked internally; the broker path is retired by default.** With
  `EXECUTION_MODE=internal` a trade is a `Position` on the platform's own book: the **stake
  is the money at risk** (a Deriv contract cannot take more than it), the multiplier scales
  the exposure and the rate the P/L moves at, and the stake is reserved out of withdrawable
  cash — opening a position is equity-neutral. `TradeRecord.notional` stores
  `stake × multiplier` explicitly, because `volume × entryPrice` is exactly right for lots
  and wrong by a factor of the price for a stake. In internal mode the managed bot's broker
  order path is **refused with a clear reason** (`EXTERNAL_EXECUTION_DISABLED`) rather than
  sending a real order alongside the internal position: one internal position plus one live
  contract would be double exposure. Positions opened from the order ticket are live today;
  the managed bot does not open internal positions itself yet.
- **Fees** are management (pro-rata) and performance (high-water-mark, charged only on
  new profit).

---

## Feature flags & admin controls

| Control | Where | Behaviour |
| --- | --- | --- |
| `engine.worker_enabled` | Admin → Settings (env `ENGINE_WORKER_ENABLED`), default `true` | Pauses **strategy generation only**. Open positions keep being marked to market and their stop-loss / take-profit levels keep being evaluated (`exit-watch` is a separate runtime), the loop keeps its lease and keeps heartbeating, and the runtime reports `engineEnabled: false` — a paused engine, not a dead worker. Takes effect within a tick or two (30s settings cache), no redeploy. |
| `bot.enabled` (emergency stop) | Admin → Bot control | Halt on **order placement**. Fail-closed: written to Redis first, read unconditionally per order, mirrored to the database, and audited. Stopping requires a reason. Use this to halt trading; use `engine.worker_enabled` to stop *new* signals without touching the exit path. |
| `risk.risk_per_trade_pct` | Admin → Bot control | Fraction of capital put at risk per trade (default 1%). |
| `risk.max_stake_usd`, `risk.daily_loss_limit_usd`, `risk.allowed_symbols`, `risk.min_payout_percentage` | Admin → Bot control | Pre-trade ceilings; `0` means no cap. |
| `payout.two_person_approval` | Admin → Settings | When true (default), an automated payout broadcast needs a second, different admin. Manual settlement is never blocked. |
| `EXECUTION_MODE` | environment | `internal` (default) books on the platform's own ledger; `broker` restores the previous path. |
| `MARKET_DATA_PROVIDER` | environment | `deriv` (default) or `twelve` — see *Market data* above for the per-instrument routing. |

Every setting is defined once in `src/server/modules/settings/settings.service.ts` with its
kind, default and environment fallback; the console form, the API and the validation are
generated from those definitions, and each change is audited (`ADMIN_SETTINGS_UPDATED`,
value never logged).

---

## Deployment

**Railway (fastest path to live):** see **[RAILWAY.md](./RAILWAY.md)** — a step-by-step
runbook for the two services, the managed Postgres/Redis, the exact variable table, and
the cross-origin realtime wiring.

The variables that decide how the platform behaves (set per service; the Twelve Data key
may also live in Admin → Settings instead of the environment):

| Variable | Value | Effect |
| --- | --- | --- |
| `EXECUTION_MODE` | `internal` | books trades on the platform's own ledger; `broker` restores the previous path |
| `MARKET_DATA_PROVIDER` | `twelve` | prefer Twelve Data for candles; live ticks and fills stay on Deriv, and synthetics/unmapped symbols fall back per instrument |
| `TWELVE_DATA_API_KEY` | your key | required while the provider is `twelve` — without it, charts for FX/metals/crypto refuse (orders still price from the live tick feed) |

**Self-hosted / Docker:** **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full runbook
(environment table, secret generation, NOWPayments/Deriv setup, TLS, the required
WebSocket proxy rule, backups and rollback), **[SECURITY.md](./SECURITY.md)** for the
security posture and an honest list of what is not yet hardened, and `docker-compose.yml`
+ `deploy/nginx/` for a reference stack.

Two deployment invariants that bite in production:

- **`NEXT_PUBLIC_WS_URL` is inlined at build time.** Changing it requires a **rebuild**,
  not a restart.
- **The realtime runtime must be reachable from the browser.** Behind one origin, the
  proxy must carry the WebSocket upgrade on `/ws/*`. On separate origins (Railway),
  the client detects the cross-origin runtime and authenticates the handshake with a
  short-lived token instead of the host-only cookie — no proxy needed.

---

## Risk disclosure

Trading leveraged instruments carries a high risk of loss. Targets published on this
platform are indicative objectives derived from historical, broker-sourced data; they are
**not** a guarantee and past performance does not predict future results. Autopipsz is not
a bank, deposits are not insured, and nothing here is investment advice. Read
[/risk](https://autopips.pro/risk) before allocating capital.

## Licence

Proprietary. © Autopipsz.
