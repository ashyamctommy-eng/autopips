import './helpers/test-env';
// eslint-disable-next-line import/order -- must load BEFORE the admin service (see file header)
import './helpers/dom-globals';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { rkey } from '@/lib/redis';
import { serverEnv } from '@/lib/env';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { createInvestment, getOverview } from '@/server/modules/account/account.service';
import {
  deriveCreditedAmountUsd,
  handleIpn,
  requestWithdrawal,
  type HandleIpnResult,
} from '@/server/modules/payments/payments.service';
import { getAdminUser } from '@/server/modules/admin/admin.service';
import { toSessionUser } from '@/server/modules/auth/session-issue';
import type { SessionUser } from '@/types/api';
import type { User } from '@prisma/client';
import {
  FIXTURE_TAG,
  TRON_PAYOUT_ADDRESS,
  assertNoFixtureRowsLeft,
  countFixtureResidue,
  createFixturePlan,
  createFixtureUser,
  createPendingDeposit,
  fixtureMetaApiAccountId,
  isDatabaseReachable,
  isRedisReachable,
  purgeFixtures,
  trackBrokerConnection,
  trackRedisKey,
} from './helpers/fixtures';

/**
 * MONEY-PATH FIX VERIFICATION — the three fixes that landed in `src/` with no
 * ratchet behind them, pinned by probes written for THIS task.
 *
 *   (a) PARTIAL-THEN-FINISHED IPN. `handleIpn` must never rewrite the
 *       requested `amountUsd` downward for a non-credited status, because that
 *       column is also the credit CEILING. The old code wrote the
 *       actually-received figure into `amountUsd` on `partially_paid`, so the
 *       later `finished` IPN was capped at the partial amount: $100 requested,
 *       $10 partially paid, then paid in full → credited $10 ($90 lost). The
 *       fixed line is
 *         `const bookable = mappedIsCredited ? amountUsd : usd(deposit.amountUsd);`
 *       and the partial figure still lives in `ipnPayload`.
 *
 *   (b) THE ROW-LOCK RACES UNDER LOAD. D7 (`requestWithdrawal`) and D8
 *       (`createInvestment`) take `SELECT id FROM "User" ... FOR UPDATE` and
 *       read the snapshot with the transaction client. These probes re-run the
 *       races with a 10-way burst and assert the EXACT number of successes the
 *       arithmetic allows — not merely "at most one" — so a guard that
 *       serialises incorrectly (or rejects everything after the first) fails.
 *
 *   (c) CROSS-SURFACE EQUALITY for a ledger that also holds a CANCELLED
 *       investment: the ledger snapshot, the client `getOverview` DTO and the
 *       admin `getAdminUser` row must all agree to the cent.
 *
 * The IPN signature is produced by an INDEPENDENT HMAC-SHA512 implementation
 * in this file (its own canonicaliser, `node:crypto`) rather than by calling
 * the module's `canonicalizeForSignature`, so a broken canonicaliser on both
 * sides cannot agree with itself.
 *
 * Runs against the real PostgreSQL + Redis; skips loudly (never silently) when
 * either is unreachable. Zero fixture residue is asserted in `afterAll`.
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[money-path-fixes] SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const redisReachable = databaseReachable ? await isRedisReachable() : false;
if (databaseReachable && !redisReachable) {
  console.warn(
    '[money-path-fixes] IPN probes SKIPPED: Redis unreachable — `claimOnce` fails CLOSED, so a ' +
      'verified IPN would be reported as a duplicate. The non-IPN probes still run.',
  );
}

const describeDb = databaseReachable ? describe : describe.skip;
const itDb = databaseReachable ? it : it.skip;
/** IPN probes additionally need Redis for the replay guard. */
const itIpn = databaseReachable && redisReachable ? it : it.skip;

/* -------------------------------------------------------------------------- */
/* Independent IPN signing (never imports the module under test)              */
/* -------------------------------------------------------------------------- */

const IPN_SECRET = serverEnv().NOWPAYMENTS_IPN_SECRET;

/** Independent recursive canonicaliser: sort keys, preserve array order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const body = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** HMAC-SHA512 over the canonical body, hex — written from the provider's spec. */
function independentIpnSignature(body: unknown, secret = IPN_SECRET): string {
  return crypto.createHmac('sha512', secret).update(stableStringify(body), 'utf8').digest('hex');
}

/** Deliver a signed IPN through the REAL handler and track its replay-guard key. */
async function deliverIpn(body: Record<string, unknown>, status: string): Promise<HandleIpnResult> {
  const signature = independentIpnSignature(body);
  const result = await handleIpn({
    rawBody: JSON.stringify(body),
    signature,
    ip: '203.0.113.7',
  });
  trackRedisKey(rkey('once', `ipn:${String(body.payment_id)}:${status}`));
  return result;
}

/* -------------------------------------------------------------------------- */

let planId = '';
let brokerId = '';

function sessionOf(user: User): SessionUser {
  return toSessionUser(user);
}

async function creditDeposit(userId: string, amountUsd: string, label: string) {
  return prisma.deposit.create({
    data: {
      userId,
      amountUsd,
      cryptoCurrency: 'usdttrc20',
      paymentId: `${FIXTURE_TAG}-payment-${label}-${crypto.randomUUID()}`,
      depositAddress: 'TFixtureAddress',
      payAmount: amountUsd,
      status: 'CONFIRMED',
    },
  });
}

async function closedTrade(investmentId: string, netPnL: string, label: string) {
  return prisma.tradeRecord.create({
    data: {
      investmentId,
      brokerId,
      metaApiPositionId: `${FIXTURE_TAG}-${label}`,
      instrument: 'XAUUSD',
      direction: 'BUY',
      volume: '0.10',
      entryPrice: '2400.00000',
      exitPrice: '2402.50000',
      grossPnL: netPnL,
      netPnL,
      status: 'CLOSED',
      closedAt: new Date('2026-09-22T12:00:00.000Z'),
    },
  });
}

describeDb('money-path fixes: partial credit, races under load, cross-surface equality', () => {
  beforeAll(async () => {
    await purgeFixtures();
    const broker = await prisma.brokerConnection.create({
      data: {
        metaApiAccountId: fixtureMetaApiAccountId('fixes'),
        brokerName: 'Fixture Broker',
        environment: 'DEMO',
        maskedAccount: '***-0004',
        balance: '0.00',
        equity: '0.00',
        freeMargin: '0.00',
        status: 'CONNECTED',
      },
    });
    brokerId = broker.id;
    trackBrokerConnection(broker.id);
    planId = (await createFixturePlan('fixes')).id;
  });

  afterAll(async () => {
    if (!databaseReachable) return;
    const report = await purgeFixtures();
    console.log(`[money-path-fixes] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    const residue = await countFixtureResidue();
    console.log(`[money-path-fixes] residue after cleanup (must be all zeros):`, residue);
    await assertNoFixtureRowsLeft();
  });

  /* ── (a) partial-payment under-credit ───────────────────────────────────── */

  describe('(a) partially_paid followed by finished credits the FULL requested amount', () => {
    itIpn('partial → full: the ceiling is not lowered, so the client is credited 100.00 (not 10.00)', async () => {
      const user = await createFixtureUser('fixes-ipn-partial-full');
      const deposit = await createPendingDeposit(user.id, '100.00', 'partial-then-full');

      // The client forwards only 10 of 100. Non-credited by definition.
      const partialBody = {
        payment_status: 'partially_paid',
        payment_id: deposit.paymentId,
        order_id: deposit.id,
        price_amount: 100,
        price_currency: 'usd',
        pay_amount: 100,
        pay_currency: 'usdttrc20',
        actually_paid: 10,
        pay_address: deposit.depositAddress,
      };
      const partial = await deliverIpn(partialBody, 'partially_paid');

      expect(partial.matched).toBe(true);
      expect(partial.duplicate).toBe(false);
      expect(partial.credited).toBe(false);
      expect(partial.status).toBe('PENDING');

      const afterPartial = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(afterPartial.status).toBe('PENDING');
      // THE REGRESSION: this column is the credit ceiling, so a non-credited
      // status must not touch it. The old bug wrote 10.00 here.
      expect(D(afterPartial.amountUsd).toFixed(2)).toBe('100.00');
      // ...and nothing was credited from the partial IPN.
      const snapAfterPartial = await getAccountSnapshot(user.id);
      expect(snapAfterPartial.breakdown.equity.toFixed(2)).toBe('0.00');
      expect(snapAfterPartial.totalCreditedDeposits.toFixed(2)).toBe('0.00');
      // The partial figure is not lost — it is recorded verbatim on the row.
      const recorded = afterPartial.ipnPayload as Record<string, unknown>;
      expect(Number(recorded.actually_paid)).toBe(10);

      // The rest of the money now arrives, in full.
      const fullBody = { ...partialBody, payment_status: 'finished', actually_paid: 100 };
      const full = await deliverIpn(fullBody, 'finished');

      expect(full.matched).toBe(true);
      expect(full.duplicate).toBe(false);
      expect(full.credited).toBe(true);
      expect(full.status).toBe('FINISHED');

      const afterFull = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(afterFull.status).toBe('FINISHED');
      // 100.00 requested, 100.00 received → 100.00 credited. The OLD bug credited
      // only the 10.00 it had rewritten into the ceiling.
      expect(D(afterFull.amountUsd).toFixed(2)).toBe('100.00');
      // the row keeps the IPN that set the current status
      const fullRecorded = afterFull.ipnPayload as Record<string, unknown>;
      expect(Number(fullRecorded.actually_paid)).toBe(100);
      expect(String(fullRecorded.payment_status)).toBe('finished');

      const snap = await getAccountSnapshot(user.id);
      expect(snap.breakdown.equity.toFixed(2)).toBe('100.00');
      expect(snap.totalCreditedDeposits.toFixed(2)).toBe('100.00');
      expect(snap.breakdown.confirmedDeposits.toFixed(2)).toBe('100.00');
    });

    itIpn('a partially_paid ALONE credits nothing and does not lower amountUsd', async () => {
      const user = await createFixtureUser('fixes-ipn-partial-only');
      const deposit = await createPendingDeposit(user.id, '250.00', 'partial-only');

      const body = {
        payment_status: 'partially_paid',
        payment_id: deposit.paymentId,
        order_id: deposit.id,
        price_amount: 250,
        price_currency: 'usd',
        pay_amount: 250,
        pay_currency: 'usdttrc20',
        actually_paid: 50,
      };
      const result = await deliverIpn(body, 'partially_paid');

      expect(result.credited).toBe(false);
      expect(result.status).toBe('PENDING');

      const row = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(row.status).toBe('PENDING');
      expect(D(row.amountUsd).toFixed(2)).toBe('250.00'); // ceiling intact

      const snap = await getAccountSnapshot(user.id);
      expect(snap.breakdown.equity.toFixed(2)).toBe('0.00');
      expect(snap.totalCreditedDeposits.toFixed(2)).toBe('0.00');
    });

    itIpn('a forged high actually_paid / price_amount can never credit above the requested amount', async () => {
      const user = await createFixtureUser('fixes-ipn-forged');
      const before = await getAccountSnapshot(user.id);
      expect(before.breakdown.equity.toFixed(2)).toBe('0.00');

      // (i) provider price far ABOVE the request: the ceiling is the request.
      const inflated = await createPendingDeposit(user.id, '250.00', 'forged-inflated-price');
      const inflatedBody = {
        payment_status: 'finished',
        payment_id: inflated.paymentId,
        order_id: inflated.id,
        price_amount: 10000, // "we think this is worth $10,000"
        price_currency: 'usd',
        pay_amount: 250,
        pay_currency: 'usdttrc20',
        actually_paid: 999999,
      };
      const inflatedResult = await deliverIpn(inflatedBody, 'finished');
      expect(inflatedResult.credited).toBe(true);

      const inflatedRow = await prisma.deposit.findUniqueOrThrow({ where: { id: inflated.id } });
      expect(D(inflatedRow.amountUsd).toFixed(2)).toBe('250.00');

      // (ii) unit price consistent with the request, absurd actually_paid.
      const inflated2 = await createPendingDeposit(user.id, '250.00', 'forged-huge-paid');
      const inflated2Body = {
        payment_status: 'finished',
        payment_id: inflated2.paymentId,
        order_id: inflated2.id,
        price_amount: 250,
        price_currency: 'usd',
        pay_amount: 250,
        pay_currency: 'usdttrc20',
        actually_paid: 1000000,
      };
      const inflated2Result = await deliverIpn(inflated2Body, 'finished');
      expect(inflated2Result.credited).toBe(true);

      const inflated2Row = await prisma.deposit.findUniqueOrThrow({ where: { id: inflated2.id } });
      expect(D(inflated2Row.amountUsd).toFixed(2)).toBe('250.00');

      // Two 250.00 requests → 500.00 credited, never a cent more.
      const after = await getAccountSnapshot(user.id);
      expect(after.breakdown.equity.toFixed(2)).toBe('500.00');
      expect(after.totalCreditedDeposits.toFixed(2)).toBe('500.00');
    });
  });

  /* ── (b) races under load ───────────────────────────────────────────────── */

  describe('(b) the D7/D8 row-lock holds under a 10-way concurrent burst', () => {
    itDb('withdrawals 10 × 100.00 against 600.00 free → exactly 6 succeed, 4 refused, 600.00 reserved', async () => {
      const BURST = 10;
      const FREE = '600.00';

      const user = await createFixtureUser('fixes-race-withdraw');
      const session = sessionOf(user);
      await creditDeposit(user.id, '2000.00', 'fixes-race-withdraw-dep');
      const investment = await prisma.investment.create({
        data: { userId: user.id, planId, capitalUsd: '1500.00', currentValUsd: '1500.00', status: 'ACTIVE' },
      });
      await closedTrade(investment.id, '100.00', 'fixes-race-withdraw-profit');

      const before = await getAccountSnapshot(user.id);
      expect(before.withdrawableBalance.toFixed(2)).toBe(FREE);
      const equityBefore = before.breakdown.equity.toFixed(2);

      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () =>
          requestWithdrawal({
            user: session,
            amountUsd: 100,
            cryptoCurrency: 'usdttrc20',
            payoutAddress: TRON_PAYOUT_ADDRESS,
            ip: null,
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // 600.00 / 100.00 = 6 exactly — the lock must SERIALISE, not stampede and
      // not collapse to a single winner.
      expect(fulfilled.length).toBe(6);
      expect(rejected.length).toBe(BURST - 6);
      expect(
        rejected.every((r) => (r.reason as { code?: string } | undefined)?.code === 'INSUFFICIENT_FUNDS'),
        'every refusal must be the funds guard',
      ).toBe(true);

      const reserved = await prisma.withdrawal.aggregate({
        where: { userId: user.id, status: { in: ['PENDING', 'WAITING', 'CONFIRMED', 'SENDING'] } },
        _sum: { amountUsd: true },
      });
      expect(D(reserved._sum.amountUsd).toFixed(2)).toBe(FREE); // never free × successes
      expect(D(reserved._sum.amountUsd).lessThanOrEqualTo(FREE)).toBe(true);

      const after = await getAccountSnapshot(user.id);
      expect(after.breakdown.equity.toFixed(2)).toBe(equityBefore);
      expect(after.pendingWithdrawals.toFixed(2)).toBe(FREE);
      expect(after.withdrawableBalance.toFixed(2)).toBe('0.00');
      expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(6);
    });

    itDb('investments 10 × 250.00 against 1000.00 credited → exactly 4 succeed, deployed ≤ credited', async () => {
      const BURST = 10;

      const user = await createFixtureUser('fixes-race-invest');
      const session = sessionOf(user);
      await creditDeposit(user.id, '1000.00', 'fixes-race-invest-dep');
      expect((await getAccountSnapshot(user.id)).withdrawableBalance.toFixed(2)).toBe('1000.00');

      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () =>
          createInvestment({ user: session, planId, amountUsd: 250, ip: null }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // 1000.00 / 250.00 = 4 exactly.
      expect(fulfilled.length).toBe(4);
      expect(rejected.length).toBe(BURST - 4);
      expect(
        rejected.every((r) => (r.reason as { code?: string } | undefined)?.code === 'INSUFFICIENT_FUNDS'),
        'every refusal must be the funds guard',
      ).toBe(true);

      const deployed = await prisma.investment.aggregate({
        where: { userId: user.id, status: { in: ['ACTIVE', 'PAUSED'] } },
        _sum: { capitalUsd: true },
      });
      const credited = await prisma.deposit.aggregate({
        where: { userId: user.id, status: { in: ['CONFIRMED', 'FINISHED'] } },
        _sum: { amountUsd: true },
      });
      expect(D(deployed._sum.capitalUsd).toFixed(2)).toBe('1000.00');
      // THE INVARIANT the ledger logs a bug about when violated:
      expect(D(deployed._sum.capitalUsd).lessThanOrEqualTo(D(credited._sum.amountUsd))).toBe(true);
      expect(await prisma.investment.count({ where: { userId: user.id } })).toBe(4);

      const snap = await getAccountSnapshot(user.id);
      expect(snap.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
      expect(snap.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
      expect(snap.breakdown.equity.toFixed(2)).toBe(
        snap.netContributedCapital
          .plus(snap.breakdown.realizedPnL)
          .plus(snap.breakdown.unrealizedPnL)
          .minus(snap.breakdown.deductedFees)
          .toFixed(2),
      );
    });
  });

  /* ── (c) cross-surface equality with a CANCELLED row ────────────────────── */

  itDb('(c) ledger, client DTO and admin row agree to the cent for a ledger holding a CANCELLED investment', async () => {
    const user = await createFixtureUser('fixes-cross-surface');

    // ── deposits: credited = 5000.00
    await creditDeposit(user.id, '5000.00', 'cross-confirmed');
    // Never credits, but it is on the row list so the ignored-status filter is
    // exercised rather than assumed.
    await createPendingDeposit(user.id, '9999.99', 'cross-pending-ignored');

    // ── investments
    const active = await prisma.investment.create({
      data: {
        userId: user.id,
        planId,
        capitalUsd: '2000.00',
        currentValUsd: '2020.00',
        unrealizedPnL: '30.00',
        feesDeducted: '10.00',
        status: 'ACTIVE',
      },
    });
    await prisma.investment.create({
      data: { userId: user.id, planId, capitalUsd: '500.00', currentValUsd: '500.00', status: 'PAUSED' },
    });
    await prisma.investment.create({
      data: { userId: user.id, planId, capitalUsd: '1000.00', currentValUsd: '1000.00', status: 'CLOSED' },
    });
    // The trap: a CANCELLED row carrying P/L and fees. It is not deployed, so it
    // must not contribute P/L or fees on EITHER surface.
    await prisma.investment.create({
      data: {
        userId: user.id,
        planId,
        capitalUsd: '4000.00',
        currentValUsd: '4000.00',
        unrealizedPnL: '999.00',
        feesDeducted: '888.00',
        status: 'CANCELLED',
      },
    });

    // ── trades: one CLOSED on the ACTIVE investment
    await closedTrade(active.id, '120.00', 'cross-closed');

    // ── withdrawals: 300.00 FINISHED
    await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '300.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixtureCrossSurface',
        status: 'FINISHED',
      },
    });

    /*
     * HAND ARITHMETIC (all figures verified against the raw rows above):
     *
     *   credited   = 5000.00 (CONFIRMED)           [9999.99 PENDING ignored]
     *   deployed   = 2000.00 (ACTIVE) + 500.00 (PAUSED)     = 2500.00
     *                (CLOSED 1000.00 and CANCELLED 4000.00 are not deployed)
     *   idle       = credited − deployed = 5000.00 − 2500.00 = 2500.00
     *   paid       = 300.00 (FINISHED)
     *   realized   = +120.00 (CLOSED trade)
     *   unrealized = 30.00  (CANCELLED row's 999.00 excluded)
     *   fees       = 10.00  (CANCELLED row's 888.00 excluded)
     *
     *   equity     = 2500.00 + 2500.00 + 120.00 + 30.00 − 10.00 − 300.00 = 4840.00
     *   identity   = netContributed 4700.00 + 120.00 + 30.00 − 10.00      = 4840.00 ✓
     *   withdrawable = max(0, 4840.00 − 2500.00 − 0.00)                   = 2340.00
     *
     *   If the CANCELLED row were counted it would read 4840.00 − 999.00 + 888.00
     *   = 4729.00 on one surface and (if only fees were counted) 5738.00 on the
     *   other — the two old divergence shapes.
     */
    const EQUITY = '4840.00';

    const snapshot = await getAccountSnapshot(user.id);
    const overview = await getOverview(user.id);
    const adminRow = await getAdminUser(user.id);

    // every term, hand-checked
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('2500.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('2500.00');
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe('120.00');
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe('30.00');
    expect(snapshot.breakdown.deductedFees.toFixed(2)).toBe('10.00');
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe('300.00');
    expect(snapshot.totalCreditedDeposits.toFixed(2)).toBe('5000.00');
    expect(snapshot.netContributedCapital.toFixed(2)).toBe('4700.00');
    expect(snapshot.activeCapital.toFixed(2)).toBe('2500.00');
    expect(snapshot.openInvestments).toBe(2);
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('2340.00');

    // THE CONTRACT: three independently assembled surfaces, one number.
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(EQUITY);
    expect(overview.equity.toFixed(2), 'client dashboard equity').toBe(EQUITY);
    expect(adminRow.equity.toFixed(2), 'admin users-table equity').toBe(EQUITY);
    expect(adminRow.capitalUsd.toFixed(2), 'admin deployed capital').toBe('2500.00');

    // and the CANCELLED row's books are excluded everywhere
    expect(overview.breakdown.unrealizedPnL.toFixed(2)).toBe('30.00');
    expect(overview.breakdown.deductedFees.toFixed(2)).toBe('10.00');
    expect(snapshot.breakdown.equity.toFixed(2)).not.toBe('4729.00');
    expect(adminRow.equity.toFixed(2)).not.toBe('4729.00');

    // the equity identity, written out in full
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(
      snapshot.netContributedCapital
        .plus(snapshot.breakdown.realizedPnL)
        .plus(snapshot.breakdown.unrealizedPnL)
        .minus(snapshot.breakdown.deductedFees)
        .toFixed(2),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* (a") the pure ceiling arithmetic the fix depends on (no database needed)   */
/* -------------------------------------------------------------------------- */

/**
 * Why `bookable = mappedIsCredited ? amountUsd : usd(deposit.amountUsd)` is the
 * fix: `requestedUsd` is BOTH the request and the credit ceiling.
 *
 * This is a pure-function proof that the DB test above discriminates — a
 * `finished` IPN carrying the full amount credits 100.00 when the ceiling is
 * still 100.00, and only 10.00 when the ceiling was (as the old code did)
 * overwritten with the partially-received figure. Runs without Postgres so the
 * arithmetic is pinned even in the graceful-skip path.
 */
describe('(a) the credit ceiling is the requested amount (pure, no DB)', () => {
  it('a 100.00 request paid in full credits 100.00 — but 10.00 if the ceiling was rewritten to the partial 10.00', () => {
    const provider = { providerPriceAmount: 100, providerPayAmount: 100, actuallyPaid: 100 };

    const correct = deriveCreditedAmountUsd({ requestedUsd: '100.00', ...provider });
    expect(correct.amountUsd.toFixed(2)).toBe('100.00');
    expect(correct.derived).toBe(true);

    // The ceiling the OLD code left behind after `partially_paid` (10.00 of
    // 100.00 received) and then applied to the full payment: the 90.00 hole.
    const taintedCeiling = deriveCreditedAmountUsd({ requestedUsd: '10.00', ...provider });
    expect(taintedCeiling.amountUsd.toFixed(2)).toBe('10.00');
    expect(D('100.00').minus(taintedCeiling.amountUsd).toFixed(2)).toBe('90.00');

    // ...and the cap still binds in both directions.
    const forged = deriveCreditedAmountUsd({
      requestedUsd: '100.00',
      providerPriceAmount: 100,
      providerPayAmount: 100,
      actuallyPaid: 99999,
    });
    expect(forged.amountUsd.toFixed(2)).toBe('100.00');
  });
});
