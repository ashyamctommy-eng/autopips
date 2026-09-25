# Autopipsz — session handover

_Written 2026-09-25 at the end of a long session. Read this first; it is meant to save
you the four hours it cost to learn the hard way._

---

## 1. What this is, and where

| | |
|---|---|
| Repo | `github.com/ashyamctommy-eng/autopips` (branch `main`, deploy = push) |
| Stack | Next.js 14 (App Router) · Prisma/Postgres · Redis · standalone Socket.IO **worker** |
| Prod (web) | `https://autopips-production.up.railway.app` — Railway, one service |
| Prod (worker) | **NOT DEPLOYED.** See §7. |
| Admin console | `/admin` — sign in at `/admin/login` (light theme) |
| Local suite | `npx vitest run` (313 tests), `npx tsc --noEmit`, `npm run lint`, `npm run build` |

**Push identity:** commit as `ashyamctommy-eng <ashyamctommy@gmail.com>`, never as an agent.

---

## 2. The exposure model (SETTLED — this is the decision that unblocks trading)

A Deriv **MULTUP/MULTDOWN** contract is bought with a **stake**, and the stake **is the
maximum loss**: Deriv cannot take more than it, a stop-loss can only reduce it. The
exposure the position opens is `stake × multiplier`.

Therefore:

1. **Risk is sized in dollars at risk — the stake — never in notional.**
   Targeting a notional instead would make the money at risk a function of the multiplier,
   which is configuration, not client capital.

   ```
   stake    = min( capital × riskPerTradePct            (risk.risk_per_trade_pct)
                 , capital × maxDrawdownPct − lossTaken  (the plan's own stop, as money left)
                 , platformMaxStake )                    (risk.max_stake_usd, 0 = no cap)
   notional = stake × multiplier                          (DERIV_MULTIPLIER, default 100)
   ```

   Rounded **DOWN** to cents; skipped (never rounded up) below `MIN_STAKE_USD = 1`.
   Each ceiling is a hard bound, and a skip is a first-class outcome recorded in the audit
   trail with the reason — `NO_CAPITAL`, `RISK_PER_TRADE_UNSET`, `MULTIPLIER_UNSET`,
   `DRAWDOWN_BUDGET_EXHAUSTED`, `BELOW_MINIMUM_STAKE`.

2. **The ledger stores both numbers explicitly.** `TradeRecord.volume` is the STAKE for a
   stake-denominated broker (lots for MT5), and the new `TradeRecord.notional` column holds
   `stake × multiplier`. The open-exposure metric is
   `SUM(COALESCE(notional, volume × entryPrice))` — correct for both shapes.
   _Before this, exposure for a Deriv position read `stake × entryPrice`: a $100 stake on gold
   at 4270 would have shown **$427,000** instead of $10,000._

3. **No conversion between lots and stakes, ever.** Adapters declare `sizeDenomination`;
   a request carrying the wrong one is refused (`STAKE_REQUIRED`), not converted, because
   converting needs a contract size Deriv does not publish.

Where it lives: `src/server/modules/bot/stake.allocator.ts` (pure, 13 tests),
`src/server/modules/bot/order.manager.ts` (the `'stake'` branch), `src/server/accounting/ledger.ts`
(`getOpenExposure`), admin control at **Admin → Bot control → Risk per trade (%)**.

**Sizing is per CLIENT investment** from that client's own capital — the master account's lot
size and equity are not inputs (they describe the broker account, not the money being risked).

---

## 3. Current state — verified, not assumed

**Working on production (checked live):**

- Sign-in, light admin console, `/admin/login`, the kill switch, plan create **with an example
  format** in the dialog.
- Market data from Deriv's **public** feed: `GET /api/v1/market/candles?symbol=frxXAUUSD&timeframe=1h&limit=300`
  → real bars, `source: 'broker'`. The trading page renders them (115 kB of real candles were
  drawn the last time it was checked in a browser).
- Broker connection: **`DOT94640065` (DEMO), balance/equity 10000, `CONNECTED`, latency ~89 ms.**
  Registered through the console's own OTP flow.
- The rename `metaApiAccountId → derivAccountId` / `metaApiPositionId → derivContractId`
  (pure `RENAME COLUMN` + `RENAME INDEX`, applied on prod).

**Not working yet — do not describe the platform as trading:**

1. **The worker is not deployed**, so there is no Socket.IO server and no bot runtime: no live
   ticks, no strategy signals, no bot activity feed. The panel honestly says "Disconnected".
2. **No order has been placed.** The stake path is unit-tested and the auth path is proven
   against the live broker, but the first real order still needs a supervised run (§7).
3. NOWPayments keys are still `CHANGE_ME` placeholders; KYC S3 vars may or may not be set.

---

## 4. Deriv integration — what the current API actually is

Deriv **migrated** and retired the old host. This is the trap that cost most of a day:

| | |
|---|---|
| Retired (dead) | `ws.derivws.com`, `ws.binaryws.com` — **520 to every request**, every path, every app_id, from a cloud sandbox, from Railway, and from a real browser |
| Public market data | `wss://api.derivws.com/trading/v1/options/ws/public` — **no auth** |
| Account/trading | REST `https://api.derivws.com` + `Authorization: Bearer <PAT>` + **`Deriv-App-ID`** header → `POST /trading/v1/options/accounts/{accountId}/otp` → `{data:{url:"wss://…/ws/demo\|real?otp=…"}}` |

- The protocol itself is unchanged (`echo_req` / `msg_type`), so message shapes carried over.
- **No `authorize` message exists on the new surface.** Authentication happens when the socket
  is issued. `is_virtual` is gone from `balance` — the account type comes from the OTP URL path.
- `portfolio` is **request-only** (`subscribe` is rejected: "Properties not allowed").
  `balance` does stream. `{portfolio:1}` feeds the position-delta detector on each poll.
- `active_symbols` must NOT send `product_type`, and its fields are **`underlying_symbol` /
  `underlying_symbol_name` / `pip_size`** — not `symbol` / `display_name` / `pip`.
- The token is a **PAT** (`pat_…`). The account id is a **trading account** (`DOT94640065` demo,
  `ROT92685247` real) — **not** the Deriv user number (`6316571` is a user number; using it
  produces an "invalid account id" error).

`DERIV_API_URL` pointing at a retired host is **refused at boot** with the replacement named.

---

## 5. Verification recipes

```bash
# Local stack (this sandbox): Postgres 14 + Redis
sudo pg_ctlcluster 14 main start
sudo redis-server --daemonize yes --port 6379 --save ''
export DATABASE_URL='postgresql://autopips:autopips@127.0.0.1:5432/autopips?schema=public'
export REDIS_URL='redis://127.0.0.1:6379' NODE_ENV=production DERIV_APP_ID=<their app id>
npx prisma migrate deploy && npm run build && node_modules/.bin/next start -p 3110

# Is Deriv reachable at all? (control test FIRST — see §6)
curl -s -o /dev/null -w '%{http_code}\n' https://api.derivws.com/trading/v1/options/ws/public   # 404 = alive
curl -s -o /dev/null -w '%{http_code}\n' https://ws.derivws.com/websockets/v3?app_id=1089        # 520 = RETIRED

# Do the credentials work? (read-only, no side effects)
curl -s -H "Authorization: Bearer $PAT" -H "Deriv-App-ID: $APP" \
  https://api.derivws.com/trading/v1/options/accounts

# Register a connection (admin session cookie required)
curl -s -b cookies.txt -X POST $PROD/api/v1/admin/brokers -H 'content-type: application/json' \
  -d '{"derivAccountId":"DOT94640065","brokerName":"Deriv demo","environment":"DEMO","token":"<PAT>"}'

# Chart data
curl -s -b cookies.txt "$PROD/api/v1/market/candles?symbol=frxXAUUSD&timeframe=1h&limit=5"
```

**Dashboard figures:** `openMarketExposure` is notional, `openPositions` counts rows; both come
from `getOpenExposure()`. Naming in a connection's `environment` is what the operator submitted,
so DEMO/LIVE is a label — the account type Deriv issues is what the adapter derives.

---

## 6. Known traps (each of these cost real time)

1. **A retired vendor endpoint looks like a network fault.** A Cloudflare **520** from a vendor
   whose other hosts answer normally is the HOST, not your network. Always run a control test
   (`wss://echo.websocket.org` opens here) and read the vendor's *current* docs before believing
   a remembered URL.
2. **An error three layers from its cause.** "Could not reach Deriv: 520" was surfaced by the
   broker probe; the cause was a decommissioned endpoint. Surface the failing *operation and
   host* in errors, not just the socket's complaint.
3. **A prerequisite that is not enforced at boot silently half-works.** The env contract was
   validated lazily, so a missing `DERIV_APP_ID` broke only sign-in. `src/instrumentation.ts`
   now validates at boot and `process.exit(1)`s (Next 14 logs a throwing hook and then reports
   "Ready" anyway — an explicit exit is required).
4. **Migrations must run in the image entrypoint**, never in host config-as-code, and never via
   `prisma db push` (it bypasses the history the entrypoint depends on). `docker-entrypoint.sh`
   runs `migrate deploy` fail-closed.
5. **The refresh token rotation is single-use with replay detection** that revokes the whole
   session family. Never fire two refreshes concurrently: `src/lib/session-refresh.ts` dedupes,
   jitters, skips hidden tabs and never auto-retries. `apiFetch` is for authenticated calls
   only — not for sign-in, where a 401 means "wrong password".
6. **httpOnly cookies only.** Nothing auth-related belongs in localStorage, and the CSS theme is
   scoped with `html:has(.theme-admin)` (not the wrapper) so Radix portals inherit it.
7. **Money-path discipline:** adapters declare their size denomination; ledger figures come from
   the broker; nothing is interpolated, rounded up, or defaulted into existence. If a number
   cannot be produced honestly, the outcome is a skip/refusal with a reason. **Keep it.**
8. **When they hand over a brief, reconcile it against the repo first.** Four briefs in a row
   contained false premises (`@tradingview/lightweight-charts` 404s, no `SystemConfig` table,
   `authorize` on a retired host, `db push` for a live schema). Following one literally would
   have kept the platform dead.

---

## 7. Next steps, in priority order

1. **Deploy the worker** — `Dockerfile.worker` + `railway.worker.toml`. This turns on live
   ticks, the bot runtime and the activity feed. **⚠️ It also starts the strategy engine, which
   can place orders on the CONNECTED account (currently DEMO).** Before deploying, decide
   whether to engage the kill switch (Admin → Bot control) and watch the first signals, or set
   `risk.risk_per_trade_pct` to 0 so stake-sized orders are refused until you are ready.
2. **Supervise the first order.** With the worker up and a DEMO connection: watch
   Admin → Bot control (live feed), confirm one `STAKE_ALLOCATED` audit row with the stake,
   notional and bounds, then confirm the position's notional in the AUM dashboard matches
   `stake × multiplier` (this is the figure the exposure model exists to make right).
3. **Then consider LIVE** (`ROT92685247`) — only after a demo cycle looks right, and with
   `risk.max_stake_usd` set to something small.
4. Optional, in any order: a user-facing light/dark toggle (the token system is ready — one CSS
   block plus a class), real NOWPayments keys, and a stake-aware broker-sync review.

---

## 8. Housekeeping (please do these)

- **Rotate the Deriv PAT** — it was pasted into a chat twice and carries trade scope. Create a
  new one in Deriv, re-register the connection with it, revoke the old.
- **Revoke the old GitHub PAT** (`ghp_…14Rjov`) used for pushes from the sandbox.
- **Delete the probe account** `probe-not-a-real-user-9f2@example.com` from production
  (there is no user-delete endpoint by design; a `DELETE FROM "User"` is needed).
- **Change the admin password** `Poriotke` (it fails the platform's own 12-character policy).

---

## 9. Where the durable knowledge lives

The agent's memory (outside this repo) carries the detail behind every decision above:
`autopips-deriv-broker-swap`, `autopips-deriv-live-integration-state`,
`autopips-bot-control-and-kill-switch`, `autopips-market-data-architecture`,
`autopips-design-tokens-and-theming`, `session-refresh-never-wired`,
`third-party-endpoint-retired-masquerading-as-network-error`,
`platform-config-gates-and-connectivity-healthchecks`, `verify-handover-briefs-against-the-repo`.

If you pick this up in a new session, read those before changing the broker, market-data,
session or theming layers.
