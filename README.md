# Autopipsz — autopips.pro

Managed algorithmic trading platform. Client capital is mirrored onto MetaTrader 4/5
accounts through **MetaApi.cloud**, settlements run through **NOWPayments.io**, and
every figure the platform reports is derived from a persisted, verified record.

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
   verified NOWPayments IPN callback, a MetaApi broker event, or an admin action that
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
   stored in a **private** S3 bucket with SSE, and viewable by an admin only through
   **300-second** pre-signed URLs — every view is written to the audit log.
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
  • bot runtime + broker sync               └──> MetaApi.cloud ──> MT4 / MT5
                                            └──> NOWPayments.io
                                            └──> AWS S3 (private, KYC)
```

Why two processes: a Next.js App Router app cannot host a Socket.io server. The socket
server and the bot runtime run as a standalone Node process (`src/server/main.ts`) and
communicate with the web tier over **Redis pub/sub**, so any replica can publish a live
event and the socket tier fans it out to authorised rooms. The bot runtime takes a Redis
lock, so only one instance trades at a time.

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
│   │   ├── kyc/             private S3 storage, admin review
│   │   ├── payments/        NOWPayments client, IPN verification, deposits, withdrawals
│   │   ├── broker/          MetaApi adapter, registry, sync
│   │   ├── bot/             risk engine, lot allocator, strategy engine, order manager, fees
│   │   ├── account/         client account service
│   │   ├── admin/           admin service
│   │   └── audit/           append-only audit logger
│   ├── ws/                  event bus, socket server
│   └── main.ts              socket + bot runtime entrypoint
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

POST   /api/v1/kyc/upload                     (multipart, 4 documents)
POST   /api/v1/kyc/submit
GET    /api/v1/kyc/me

GET    /api/v1/payments/deposits | withdrawals | currencies
POST   /api/v1/payments/deposits | withdrawals
POST   /api/v1/payments/nowpayments/ipn       (HMAC-authenticated webhook)

GET    /api/v1/market/candles

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
  duplicate signal, equity floor, drawdown, open-position cap, lot cap, symbol tradable,
  free margin) run before any order. A check that cannot be evaluated is a rejection.
  Client lots are scaled by `Client Lot = Master Lot × (Client Investment Capital /
  Master Account Equity)` and always rounded **down** to the symbol's volume step.
- **Fees** are management (pro-rata) and performance (high-water-mark, charged only on
  new profit).

---

## Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full runbook (environment table, secret
generation, S3/NOWPayments/MetaApi setup, TLS, the required WebSocket proxy rule,
backups and rollback), **[SECURITY.md](./SECURITY.md)** for the security posture and an
honest list of what is not yet hardened, and `docker-compose.yml` + `deploy/nginx/` for a
reference stack.

---

## Risk disclosure

Trading leveraged instruments carries a high risk of loss. Targets published on this
platform are indicative objectives derived from historical, broker-sourced data; they are
**not** a guarantee and past performance does not predict future results. Autopipsz is not
a bank, deposits are not insured, and nothing here is investment advice. Read
[/risk](https://autopips.pro/risk) before allocating capital.

## Licence

Proprietary. © Autopipsz.
