# Ledger verifier findings — autopips-pro

Repo: `/home/user/.workspace/autopips-pro` · Verifier round 2 · 2026-09-23
Run: `npm test` (11 files, 199 tests — see "Test-suite state" at the bottom).

Scope: verification of the corrected accounting after the D1/D2/D3 fixes landed in `src/`.
**No file under `src/**` or `prisma/**` was modified.** Only `tests/**` changed:

| file | change |
|---|---|
| `tests/integration-ledger.test.ts` | expectations recomputed for the fixed ledger; the three `it.fails` D1/D2 ratchets **promoted to passing `it(...)`**; 2 tests added |
| `tests/money-path-e2e.test.ts` | **new** — end-to-end money path through the real services |
| `tests/accounting-adversarial.test.ts` | **new** — adversarial probes + the cross-surface consistency test |
| `tests/money-path-races.test.ts` | **new** — concurrent check-then-act probes (D7/D8) |
| `tests/helpers/fixtures.ts` | shared fixture builders + a typed `createFixtureUser` (additive) |
| `tests/helpers/dom-globals.ts` | **new** — `window` shim so the admin service's module graph loads under vitest |
| `tests/LEDGER-VERIFIER-FINDINGS.md` | this file |

---

## Verdict: the accounting can be TRUSTED ✅

*(for the reachable money path, with the two remaining defects below held open and quantified)*

The two critical defects from round 1 are genuinely fixed, the third is fixed, and the fix is
demonstrated at three levels: pure-function arithmetic, a live-DB fixture suite with hand-computed
cent-exact expectations, and an end-to-end deposit→invest→trade→withdraw→settled run through the
real services. One shared pure assembler (`buildEquityFromAggregates`) is now the only place the
formula is applied, and the three surfaces that used to disagree — client dashboard, ledger, admin
users table — are asserted equal for the same account.

---

## Round-1 defects: status now

| id | round-1 finding | status now | evidence |
|---|---|---|---|
| D1 | FINISHED withdrawals subtracted twice once idle cash exists | **FIXED** ✅ | `ledger.ts` builds idle from GROSS `credited − deployed`; `tests/integration-ledger.test.ts` → "HEADLINE IDENTITY…", "finished withdrawals are debited exactly once when idle cash exists (D1 regression)" (was `it.fails`, now green) |
| D2 | withdrawal path ran a private pre-fix snapshot → air withdrawal | **FIXED** ✅ | `payments.service.ts` imports the ledger's `getAccountSnapshot`; `…requestWithdrawal rejects it` (was `it.fails`, now green) |
| D3 | admin had a third divergent copy | **FIXED** ✅ | `admin.service.ts::aggregateUserLedgers` calls `buildEquityFromAggregates` with `DEPLOYED_INVESTMENT_STATUSES`; asserted equal to the client surfaces in `accounting-adversarial.test.ts` |
| D4 | three implementations of one money formula | **ADDRESSED** (arithmetic is now single-implementation; the SQL assembly is still written twice — ledger + admin — but only `buildEquityFromAggregates` computes) and the requested cross-surface test now EXISTS |
| D5 | `unrealizedPnL`/`feesDeducted` summed over CANCELLED investments | **OPEN — latent** (see below) |
| D6 | nothing validates a `TradeRecord` is broker-sourced | **OPEN — observation** (unchanged) |
| — | **D7 (new): concurrent withdrawals over-reserve** | **OPEN — MEDIUM/HIGH** |
| — | **D8 (new): concurrent investments over-deploy** | **OPEN — MEDIUM/HIGH** |

### D1/D2 detail (round-1 history, kept for audit)

Round 1 found: `ledger.ts` computed `unallocatedCash = max(0, (credited − paid) − deployed)` and then
also handed `withdrawals: paid` to `computeEquity`, so every finished withdrawal was debited twice;
`payments.service.ts` kept a private copy of the pre-fix formula (all non-CANCELLED capital + gross
credited deposits) so a fully-deployed account could still withdraw its own deployed capital; and
`admin.service.ts` had a third copy. Repros and line numbers are in the round-1 revision of this file
(git history is not available in the sandbox — the descriptions are reproduced here):

* D1 repro: deposit 1000.00 CONFIRMED, withdrawal 400.00 FINISHED, no investments → ledger reported
  **200.00**, correct **600.00**.
* D2 repro: deposit 1000.00, invest 1000.00 via `createInvestment` (ledger withdrawable 0.00) →
  `requestWithdrawal(0.01)` **created a PENDING row** instead of throwing `INSUFFICIENT_FUNDS`.
* D3: `aggregateUserLedgers` reported inflated equity for any client with money allocated.

All three now behave correctly and are pinned by tests that assert the correct contract
(`integration-ledger.test.ts` was re-derived from the fixed formula, with the arithmetic in comments
beside every number).

---

## TASK 1 — reconciled expectations (hand arithmetic, cent-exact)

The standard fixture, recomputed from the corrected formula
(`ledger.ts: buildEquityFromAggregates` → `equity.ts: computeEquity`):

```
deployed          = 10000.00 (ACTIVE) + 1000.00 (PAUSED)                = 11000.00
credited          = 11500.00 (CONFIRMED) + 500.00 (FINISHED)            = 12000.00
idle              = credited − deployed = 12000.00 − 11000.00           =  1000.00
paidWithdrawals   = 1000.00 (FINISHED)                                  =  1000.00
netContributed    = credited − paid = 12000.00 − 1000.00                = 11000.00
realizedPnL       = +250.00 − 120.45 (CLOSED only)                      =   129.55
unrealizedPnL     = 120.55 (broker-written Investment column)           =   120.55
deductedFees      = 75.25                                               =    75.25

equity  = startingCapital + confirmedDeposits + realized + unrealized − fees − withdrawals
        = 11000.00 + 1000.00 + 129.55 + 120.55 − 75.25 − 1000.00        = 11174.85
identity= netContributed + realized + unrealized − fees
        = 11000.00 + 129.55 + 120.55 − 75.25                            = 11174.85   ✓

activeCapital     = 11000.00 (ACTIVE + PAUSED stay locked)
pendingWithdrawals= 250.00 (PENDING) + 100.00 (SENDING)                 =   350.00
withdrawable      = max(0, 11174.85 − 11000.00 − 350.00) = max(0,−175.15) =    0.00
openInvestments   = 2
```

The old buggy value (`10174.85`) is exactly `11174.85 − 1000.00`, i.e. the extra `− paid` — so the
regression is provably gone, not merely un-asserted. Both identities are now asserted explicitly
(`netContributed === startingCapital + confirmedDeposits − withdrawals` and
`equity === netContributed + realized + unrealized − fees`), including a variant that re-reads every
term from the persisted rows rather than from the ledger's own breakdown.

Every mutation test in the file was recomputed on the same basis (deposit confirmation ±1234.56,
in-flight → FINISHED withdrawal −250.00, closing a CLOSED trade +100.00, closing an investment
equity-neutral, broker loss −333.33, unrealized injection +4444.44). Two new tests were added:
"the equity identity holds when every term is re-read from the persisted rows" and
"finished withdrawals are debited exactly once when idle cash exists (D1 regression)".

### The ratchets were promoted, not deleted

| test | before | after |
|---|---|---|
| `HEADLINE IDENTITY: equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees` | `it.fails` (D1) | `it` — **passes** |
| `a withdrawal larger than the idle cash is impossible — requestWithdrawal rejects it` | `it.fails` (D2) | `it` — **passes** |
| `finished withdrawals are debited exactly once when idle cash exists` | `it.fails` (D1) | `it` — **passes** |

No promoted test needed a weakened assertion. The only body that had to be edited (beyond numbers)
was the D1 idle-cash one, whose `confirmedDeposits` expectation still encoded the *net* idle model
(`600.00`) — with the fix that field is GROSS idle (`1000.00`), and the test now asserts both that and
the `600.00` equity.

---

## TASK 2 — end-to-end money path (`tests/money-path-e2e.test.ts`, 8 tests, all green)

Real services, real PostgreSQL, a real HMAC. Nothing is hand-seeded except the deposit row that
`createDeposit` would have persisted after the provider round-trip (which needs the NOWPayments API):

| step | driven through | asserted |
|---|---|---|
| a | real Argon2id hash + real `toSessionUser` mapper, row read back from the DB | equity 0.00, no invented balance, `openInvestments 0` |
| b | **`handleIpn`** with a body signed by an INDEPENDENT HMAC-SHA512 implementation (its own canonicaliser, `node:crypto`) | deposit reaches FINISHED, `credited:true`, equity **0 → 1000.00**, `confirmedDeposits`(idle) 1000.00, `startingCapital` 0.00 |
| c | real **`createInvestment`** (full 1000.00) | equity **1250→… unchanged 1000.00 to the cent**, `startingCapital` 1000.00, idle 0.00, `withdrawableBalance` 0.00, `openInvestments` 1 |
| d | real **`requestWithdrawal(0.01)`** + a second `createInvestment` | both throw `INSUFFICIENT_FUNDS`; **zero** withdrawal rows left behind |
| e | `TradeRecord` written exactly as the broker sync writes a closed deal (+250.00, CLOSED) | equity **→ 1250.00** (+250.00 exactly), `withdrawableBalance` **250.00** |
| f | real **`requestWithdrawal(250.00)`** | succeeds, PENDING; equity unchanged 1250.00, `pendingWithdrawals` 250.00, `withdrawableBalance` 0.00; a second request for the same money is refused |
| g | real **`decideWithdrawal(APPROVE, txHash)`** (the admin path) | row FINISHED + `approvedBy` set; equity **→ 1000.00** (−250.00 exactly, back to the post-deposit level), `withdrawableBalance` 0.00 |
| h | final tally | credited 1000.00, paid 250.00, P/L +250.00, deployed 1000.00, idle 0.00 ⇒ **equity 1000.00** |

At **every** step the test re-aggregates all six terms itself with `findMany` + `Decimal` sums (a
different query shape from the ledger's `aggregate`) and asserts
`equity === credited − paid + realizedPnL + unrealizedPnL − fees`, plus every component field, plus
`withdrawableBalance = max(0, equity − deployed − pending)`.

Cleanup: `purgeFixtures()` + printed residue counts + `assertNoFixtureRowsLeft()`; also deletes the
IPN replay-guard Redis key it created. Verified at the SQL level after the suite: **0** rows in
`User` / `TradingPlan` / `Investment` / `Deposit` / `Withdrawal` / `TradeRecord` tagged `verify-suite-%`,
and `AuditLog` back to its 3 original rows.

---

## TASK 3 — adversarial review: what held, what broke

Read in full: `src/server/accounting/{equity,ledger,strategy-stats}.ts`.

| probe | result |
|---|---|
| CLOSED investment (capital returned to idle) | **holds** — equity unchanged to the cent; deployed 8000→500, idle 1250→8750 (`500+8750 = 9250 = credited`), and the released capital becomes withdrawable (9150.90−500−150 = 8500.90) |
| in-flight PENDING/SENDING withdrawal | **holds** — excluded from equity (equity debit = FINISHED only), included in `pendingWithdrawals`, the two are disjoint; settling the 120.00 PENDING row moves equity by exactly −120.00 and shrinks the reservation by the same 120.00 |
| negative equity (losses exceed capital) | **holds, honest** — equity `−4000.00` is reported as `−4000.00` (never clamped), `netProfit −5000.00`, `netReturnPct −500.0000`; only `withdrawableBalance` is floored at 0.00 (correctly — it is a spending limit, not a valuation) |
| deposit AFTER an investment | **holds, but see the clamp caveat** — a late deposit double-counts nothing (equity stays 1000.00 when the 1000.00 finally funds a 1000.00 investment). In the *unfunded* sub-state (`deployed > credited`) identity (II) does **not** hold; the ledger clamps idle to 0 and logs `[ledger] deployed capital (…) exceeds credited deposits (…)`. Unreachable via real services; a safety property is preserved (nothing is inflated above what is deployed) |
| two deposits | **holds** — 300.00 + 700.00 credits 1000.00, never 1300.00; delta per deposit is exact |
| over-withdrawal attempt (serial) | **holds** — 600.01 refused, 600.00 accepted, second 600.00 refused, nothing persisted on refusal |
| over-withdrawal attempt (CONCURRENT) | **BROKEN — D7** (below) |
| `admin.service.aggregateUserLedgers` vs `getAccountSnapshot` | **holds** for a rich ledger — both 9150.90, and `getOverview` (the client DTO) matches them, and the admin row's `capitalUsd` equals the ledger's deployed figure |
| `getPlatformLedger()` vs the formula over platform aggregates | **holds** — equal to the cent |
| strategy-stats with zero closed trades | **holds** — `null`, never 0%/100% (`indicativeOnly: true` always) |
| strategy-stats return denominator | **observation** — see OBS-2 |
| CANCELLED investment (clean, no P/L/fees) | **holds** — neither surface locks its capital; both report 1000.00 |
| CANCELLED investment carrying `feesDeducted`/`unrealizedPnL` | **BROKEN — D5** (latent) |

The cross-surface test (the one D4 asked for) is
`CROSS-SURFACE: client overview, ledger snapshot and admin row all report 9150.90 for the same account`:
one user, four deposits (two of them non-crediting), three investments, three trades (one OPEN that
must never be read), four withdrawals in four different states — and all three surfaces are asserted
equal to the cent, plus every component field and a finite-number sweep.

---

## Remaining defects

### D7 — MEDIUM/HIGH: `requestWithdrawal` has no guard against concurrent requests (OPEN)

**Where:** `src/server/modules/payments/payments.service.ts` — `requestWithdrawal`: the
`const snapshot = await getAccountSnapshot(user.id)` / `if (amount.greaterThan(snapshot.withdrawableBalance))`
pair and the `prisma.withdrawal.create(...)` that follows it. No transaction, no `SELECT … FOR UPDATE`,
no unique/check constraint, no Redis lock.

**Repro:** deposit 2000.00, deploy 1500.00, book +100.00 ⇒ 600.00 free. Fire three concurrent
`requestWithdrawal(600)` calls (`Promise.all`). Observed: **all three accepted**, 1800.00 reserved
against 600.00 of free money. (Isolated bursts of 8 reproduced up to 4800.00 reserved.)

**Impact:** the reservations are what an admin approves, so the platform can be made to pay out more
than the client had free; once settled, equity is debited for money the client never had. Reachable
from one authenticated client (two tabs, a script, or a retried request), so it needs no attacker —
just concurrency. Mitigated only by the fact that a human approves each payout.

**Fix direction:** one interactive transaction with `SELECT … FOR UPDATE` on the user row (or
`Serializable` isolation), or a DB-level guard (partial unique index on an open withdrawal per user;
or a CHECK that the sum of open reservations ≤ equity). A per-user `claimOnce` Redis lock closes it
for the single-process case.

**Pinned by:** `tests/money-path-races.test.ts` → `KNOWN SRC DEFECT D7: concurrent withdrawals must
not over-reserve the account` (`it.fails`, retry-widened so it is not timing-flaky; promote when fixed).

### D8 — MEDIUM/HIGH: `createInvestment` has the same race (OPEN)

**Where:** `src/server/modules/account/account.service.ts` — `createInvestment`: the
`if (amount.greaterThan(snapshot.withdrawableBalance))` gate and the `prisma.investment.create(...)`
after it.

**Repro:** deposit 1000.00; fire two concurrent `createInvestment(1000)`. Observed: **both accepted**,
`deployed = 2000.00` on `credited = 1000.00` — the exact state `buildEquityFromAggregates` logs as an
inconsistency, in which equity identity (II) no longer holds (the client has 2000.00 of strategy
exposure on 1000.00 of deposits).

**Impact:** over-exposure the platform never intended to allow, plus a ledger state the code itself
flags as a bug. Also the entry point for the "unfunded deployment" caveat above (the D8 state is
exactly `deployed > credited`).

**Pinned by:** `tests/money-path-races.test.ts` → `KNOWN SRC DEFECT D8: concurrent investments must not
over-deploy the account` (`it.fails`).

### D5 — LOW (latent): admin and client disagree on a CANCELLED investment's P/L and fees (OPEN)

**Where:** `src/server/accounting/ledger.ts` — `getAccountSnapshot`'s `portfolio` aggregate
(`prisma.investment.aggregate({ where: { userId }, _sum: { unrealizedPnL, feesDeducted } })`, no
status filter) versus `src/server/modules/admin/admin.service.ts:227`
(`where: { userId: { in: userIds }, status: { not: 'CANCELLED' } }`).

**Repro:** deposit 1000.00 + one `status: 'CANCELLED'` investment with `unrealizedPnL 5.00`,
`feesDeducted 12.34`. Client ledger: `0 + 1000 + 5.00 − 12.34` = **992.66**. Admin row:
**1000.00**. Gap **7.34** for the same account.

**Why it is only latent:** no code path in `src/**` ever writes `Investment.status = 'CANCELLED'`
(only the schema enum and UI filters mention it), so today the two surfaces agree. It becomes reachable
the moment an admin/refund path cancels an investment that has fees or unrealized P/L booked.

**Impact:** two different numbers for one account — the same failure class as D3.

**Fix direction:** make one side match the other — either exclude CANCELLED from the ledger's
`portfolio` aggregate (the admin's reading: a cancelled investment has no live P/L and its fees are
not the client's) or drop the filter in admin. Only one of them should move.

**Pinned by:** `tests/accounting-adversarial.test.ts` → `LATENT DEFECT D5 (pinned): a CANCELLED row
with fees/unrealized P/L makes admin and client disagree` — it passes today by pinning the exact 7.34
gap, so a src change flips it and forces a re-read.

### OBS-1 — LOW: identity (II) does not hold in the `deployed > credited` (unfunded) state

`buildEquityFromAggregates` clamps idle to 0 and logs `[ledger] deployed capital (X) exceeds credited
deposits (Y)`. Equity then counts deployed capital that was never credited, so
`equity ≠ netContributed + P/L − fees` (e.g. deployed 1000.00 / credited 0.00 ⇒ equity 1000.00,
netContributed 0.00). Unreachable through the real services (both money-entry points gate on
`withdrawableBalance`), **but D8 makes it reachable**, which raises its importance. Direction is safe
(never inflates above deployed). Pinned by
`LATE deposit after the capital was deployed double-counts nothing (and the clamp is honest)`.

### OBS-2 — LOW: `strategy-stats` measures observed return against ALL plan capital

`src/server/accounting/strategy-stats.ts` — `investments = prisma.investment.findMany({ where: { planId } })`
(no status filter) feeds both the drawdown and the `observedReturnPct` denominator. A CLOSED
investment's capital is still in the denominator, so the figure is systematically understated
(200.00/4000.00 = 3.75% where the live 1000.00 would give 15.00%). Conservative, never inflated, and
always labelled `indicativeOnly: true`, so it is an observation rather than a defect — but it is a
number a client will read. Pinned in `accounting-adversarial.test.ts` (documents the denominator).

### OBS-3 — LOW: no re-check of the withdrawable balance at payout time

`decideWithdrawal` transitions PENDING → SENDING/FINISHED without re-reading the ledger, so a
withdrawal requested when the account was solvent can be settled after losses have made it insolvent.
Equity then reports the resulting negative figure honestly, so nothing is hidden — but a margin-style
re-check at approval time is worth owning deliberately.

### OBS-4 — LOW: stale doc comments in `src/types/api.ts:48-61`

`AccountOverview.breakdown` still documents the pre-fix model ("Together with `unallocatedCash` this
is the capital half … the two are a partition of contributed capital", "`= startingCapital +
confirmedDeposits = net contributed capital`"). `startingCapital + confirmedDeposits` is now GROSS
credited capital, and `netContributedCapital = credited − paid`. Comment-only, but it is exactly the
sentence the next engineer will trust instead of the code.

### OBS-5 — pre-existing, unchanged from round 1: the partially-paid → finished under-credit

Recorded last round and not re-tested: a deposit requested at $100 that gets a `partially_paid` IPN
(row rewritten to $10.00) and is then IPN'd `finished` credits only $10.00, because `handleIpn` uses
`deposit.amountUsd` as the ceiling after `depositedAmountForNonCredit` rewrote it. Under-credits (never
over-credits). `src/server/modules/payments/payments.service.ts` (`handleIpn`, `deriveCreditedAmountUsd`,
`depositedAmountForNonCredit`). Worth a regression test when the owner picks it up.

---

## Test-suite state

```
$ npm test
 ✓ tests/integration-ledger.test.ts (24 tests)
 ✓ tests/equity.test.ts (32 tests)
 ✓ tests/risk-engine.test.ts (27 tests)
 ✓ tests/ipn-hmac.test.ts (25 tests)
 ✓ tests/lot-allocator.test.ts (23 tests)
 ✓ tests/fees.test.ts (19 tests)
 ✓ tests/indicators.test.ts (13 tests)
 ✓ tests/no-fabricated-data.test.ts (13 tests)
 ✓ tests/accounting-adversarial.test.ts (12 tests)
 ✓ tests/money-path-e2e.test.ts (8 tests)
 ✓ tests/money-path-races.test.ts (3 tests)

 Test Files  11 passed (11)
      Tests  199 passed (199)
```

* **Start of this round:** 163 passed / 12 failed (all 12 in `integration-ledger.test.ts`).
* **End of this round:** 199 passed / 0 failed. **Zero tests skipped** (PostgreSQL 14 + Redis 6 are
  both live). 2 of the 199 are `it.fails` quarantines documenting D7/D8 (they count as passing while
  the defect is present, and will report "expected to fail but passed" once src is fixed).
* `npx tsc --noEmit` — **0 errors**.
* Graceful skip verified: `DATABASE_URL=postgresql://127.0.0.1:59999/nope npx vitest run …` over the
  four DB-backed files → `Test Files 4 skipped (4)`, `Tests 47 skipped (47)`, **exit 0**, with loud
  `SKIPPED: no reachable SQL database` warnings.
* Fixture hygiene: every file prints its purge report and residue counts and asserts all zeros; the
  database was re-checked directly with `psql` after the run — `User`/`TradingPlan`/`Investment`/
  `Deposit`/`Withdrawal`/`TradeRecord`/`BrokerConnection` tagged `verify-suite-%` = **0**, `AuditLog`
  = its 3 original rows. (2 `BrokerConnection` rows exist that are **not** ours — a concurrent sibling
  agent's smoke script, same as last round.)
* Three consecutive full-suite runs were green before this report was written (the D7/D8 quarantines
  reproduce under load; their bodies widen the burst until the interleaving is observed rather than
  depending on a single timing draw).

### Notes on how this round's tests are built

* All money assertions compare exact cent strings (`toFixed(2)`), never floats, and the arithmetic is
  written in comments beside each number.
* `money-path-e2e` signs the IPN with its own canonicaliser + `node:crypto`, so a bug in the module's
  canonicalisation cannot agree with itself.
* `accounting-adversarial` re-aggregates the ledger independently (`findMany` + Decimal sums) instead
  of trusting the breakdown it is checking, and the cross-surface test compares client DTO, ledger and
  admin service row.
* `tests/helpers/dom-globals.ts` sets a minimal `window` because vitest resolves `metaapi.cloud-sdk`'s
  **browser** build (the ESM `import` condition) while Next.js resolves the CJS build; without the
  shim, importing `admin.service` throws `ReferenceError: window is not defined`. The shim is test-only
  and does not touch `src/**` or `vitest.config.ts`.

---

# Round 3 — re-verification after the D5/D7/D8 + partial-credit + strategy-stats fixes

Repo: `/home/user/.workspace/autopips-pro` · Verifier round 3 · 2026-09-23

Scope: five fixes landed in `src/`; 4 ratchet tests encoded the OLD behaviour and were reconciled.
**No file under `src/**` or `prisma/**` was modified.** Only `tests/**` changed:

| file | change |
|---|---|
| `tests/money-path-races.test.ts` | D7/D8 `it.fails` quarantines **promoted to plain passing tests** and strengthened (exact success counts, Σ reservations == free, `deployed ≤ credited`) |
| `tests/accounting-adversarial.test.ts` | D5 divergence test **flipped to an equality contract**; strategy-stats denominator expectation 3.75 → **15.00** (+ drawdown 5.00); platform-window guard widened |
| `tests/money-path-fixes.test.ts` | **new** — partial-then-finished IPN credit, forged `actually_paid`, D7/D8 under a 10-way burst, cross-surface equality with a CANCELLED row |

## Verdict

| fix | verdict | evidence |
|---|---|---|
| **D7** concurrent withdrawals over-reserve | **GENUINELY FIXED** ✅ | row lock + `tx` snapshot inside one transaction; 8×600 against 600 free → exactly 1 success / 7 `INSUFFICIENT_FUNDS`; 8×200 → exactly 3; 10×100 → exactly 6 |
| **D8** concurrent investments over-deploy | **GENUINELY FIXED** ✅ | same pattern; 8×1000 against 1000 → exactly 1; 10×250 against 1000 → exactly 4, `deployed ≤ credited` |
| **D5** CANCELLED divergence | **FIXED** ✅ | both surfaces exclude CANCELLED ⇒ 1000.00 == 1000.00 (was 992.66 vs 1000.00) |
| **partial-payment under-credit** | **GENUINELY FIXED** ✅ | `partially_paid` (10 of 100) leaves the ceiling at 100.00; the later `finished` credits **100.00** (old code credited 10.00 — the 90.00 hole); forged `actually_paid` = 999999 still capped at the request |
| **strategy-stats denominator** | **FIXED** ✅ | 150.00 / 1000.00 (traded capital only) = **15.0000 %**; drawdown 50.00/1000.00 = **5.0000 %** (old: 3.75 % / 1.25 % over a 4000.00 denominator) |

## TASK 1 — the four ratchets, with hand arithmetic

* **D5 (CANCELLED)** — fixture: credited 1000.00; CANCELLED investment with `unrealizedPnL` 5.00 and
  `feesDeducted` 12.34. Correct: a CANCELLED row is not deployed (its capital is excluded by the
  ACTIVE/PAUSED filter), so it must contribute no P/L and no fees either.
  `equity = 0.00 + 1000.00 + 0.00 + 0.00 − 0.00 − 0.00 = 1000.00` on **both** surfaces. The old client
  value 992.66 and the 7.34 gap are asserted *not* to come back.
* **strategy-stats** — fixture: ACTIVE investment 1000.00 holding both CLOSED trades (+200.00, −50.00);
  a CLOSED investment 3000.00 with no trades. Denominator = 1000.00 (only investments with a CLOSED
  trade), so `observedReturnPct = 150.00 / 1000.00 × 100 = 15.0000` and
  `maxObservedDrawdownPct = 50.00 / 1000.00 × 100 = 5.0000`. Verified from the fixture by hand before
  reading the code's output; the code agrees.

## TASK 4 — adversarial re-read of the row-lock fix

Verified by reading `src/` (grep for `getAccountSnapshot`, `computeWithdrawableBalance`,
`withdrawal.create`, `investment.create`):

* `payments.service.ts:744` takes `SELECT id FROM "User" … FOR UPDATE`, `:746` reads the snapshot with
  the **`tx`** client, `:754` writes `withdrawal.create` — lock BEFORE the read it protects, same tx.
* `account.service.ts:213` / `:215` / `:225` — identical pattern for `investment.create`.
* **No missed mutual caller**: those are the only two `*.create` sites for the two money tables in
  `src/` (plus the three admin status updates in `decideWithdrawal`). Routes
  (`api/v1/payments/withdrawals`, `api/v1/account/investments`) delegate to the services.
* `computeWithdrawableBalance` is called only from `getAccountSnapshot` ⇒ every spendability decision
  flows through the locked path. `getOverview` (`account.service.ts:89`) reads it unlocked but never
  writes money.
* Both fixes depend on Postgres READ COMMITTED (no `isolationLevel` is set anywhere; Prisma/PG default)
  — under REPEATABLE READ the locking SELECT would raise 40001 instead of waiting cleanly.

### Remaining defects (reported, not fixed — `src/**` is out of scope)

* **D9 (NEW, LOW/MEDIUM — admin-only race)** `decideWithdrawal`
  (`src/server/modules/payments/payments.service.ts:860` read → `:871`/`:902`/`:925` update) is the same
  check-then-act shape as D7/D8 but with **no transaction, no lock, no compare-and-set**: two concurrent
  decisions both pass the `row.status !== 'PENDING'` guard, and the last commit wins. Repro: fire
  APPROVE and REJECT in parallel on one PENDING row → both return 200; the row lands on whichever wrote
  last (a rejected withdrawal can end up SENDING, i.e. payable). Fix direction: one transaction with the
  User row locked, or `updateMany({ where: { id, status: 'PENDING' } })` + row-count check.
* **D6 (unchanged, MEDIUM/latent)** `decideWithdrawal` still never re-reads `getAccountSnapshot` at
  payout time, so a payout reservation made when equity was healthy can be paid after a loss landed;
  equity can be driven negative (withdrawable clamps to 0, but the payout exceeds what the client has).
* **OBS-latent** `applyFees` (`src/server/modules/bot/fee.engine.ts:172`) is a read-modify-write on
  `Investment.feesDeducted` (`:194` read → the update inside the `$transaction`) with no lock/CAS — two
  concurrent calls would lose one update. **Currently unreachable**: nothing in `src/` calls `applyFees`
  (only the test suite does), so it is latent.
* **OBS** `reconcileDeposit` has no per-(payment,status) claim like `handleIpn`'s `claimOnce`, but it
  assigns (never increments) and a concurrent poll + IPN converge on the same derived value — noted, no
  action needed.

## Test-suite state (round 3)

```
$ npm test
 ✓ tests/money-path-fixes.test.ts (7 tests)
 ✓ tests/integration-ledger.test.ts (24 tests)
 ✓ tests/equity.test.ts (32 tests)
 ✓ tests/risk-engine.test.ts (27 tests)
 ✓ tests/ipn-hmac.test.ts (25 tests)
 ✓ tests/lot-allocator.test.ts (23 tests)
 ✓ tests/fees.test.ts (19 tests)
 ✓ tests/indicators.test.ts (13 tests)
 ✓ tests/no-fabricated-data.test.ts (13 tests)
 ✓ tests/accounting-adversarial.test.ts (12 tests)
 ✓ tests/money-path-e2e.test.ts (8 tests)
 ✓ tests/money-path-races.test.ts (5 tests)

 Test Files  12 passed (12)
      Tests  208 passed (208)
```

* **Start of this round:** 195 passed / 4 failed — all 4 failures were the ratchets flipping, as expected.
* **End:** 208 passed / 0 failed, **zero skips**, and 4 consecutive full-suite runs green.
* `npx tsc --noEmit` — **0 errors**.
* Graceful skip: `DATABASE_URL=postgresql://…@127.0.0.1:59999/nope npm test` →
  `Test Files 8 passed | 4 skipped (12)`, `Tests 149 passed | 59 skipped (208)`, **exit 0**, with loud
  `SKIPPED: no reachable SQL database` warnings (the new file's pure-function ceiling test still runs).
* Residue (checked directly with `psql` + `redis-cli` after the run): `verify-suite-%` rows = **0** in
  `User`/`TradingPlan`/`BrokerConnection`/`Investment`/`Deposit`/`Withdrawal`/`TradeRecord`/`AuditLog`;
  `Deposit`/`Withdrawal`/`Investment`/`TradeRecord` tables are **empty**; `autopips:once:*` Redis keys =
  **0**. The only non-seed rows (`authpages.*` / `final.*` users, `BOT_*` audit rows, 2
  `BrokerConnection`s) belong to a concurrent sibling agent, not to this suite.
