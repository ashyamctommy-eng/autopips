import './helpers/test-env';
// eslint-disable-next-line import/order -- must load BEFORE the admin service (see file header)
import './helpers/dom-globals';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import {
  buildEquityFromAggregates,
  getAccountSnapshot,
  getPlatformLedger,
} from '@/server/accounting/ledger';
import { computeEquity } from '@/server/accounting/equity';
import { getAdminUser } from '@/server/modules/admin/admin.service';
import { getStrategyStats } from '@/server/accounting/strategy-stats';
import { getOverview } from '@/server/modules/account/account.service';
import { requestWithdrawal } from '@/server/modules/payments/payments.service';
import { toSessionUser } from '@/server/modules/auth/session-issue';
import type { SessionUser } from '@/types/api';
import {
  FIXTURE_TAG,
  TRON_PAYOUT_ADDRESS,
  assertNoFixtureRowsLeft,
  countFixtureResidue,
  createFixturePlan,
  createFixtureUser,
  fixtureMetaApiAccountId,
  isDatabaseReachable,
  purgeFixtures,
  trackBrokerConnection,
} from './helpers/fixtures';
import type { PaymentStatus, User } from '@prisma/client';

/**
 * ADVERSARIAL ACCOUNTING PROBES — the verifier trying to BREAK the corrected
 * ledger, not to confirm it.
 *
 * Every test in this file asks one of the three questions the task poses:
 *   * is the reported equity the money the client actually has?
 *   * can a number be invented (inflated, clamped, or double-counted)?
 *   * do two surfaces report DIFFERENT values for the SAME account?
 *
 * The headline test is the cross-surface one: `getOverview` (what the client's
 * dashboard renders), `getAccountSnapshot` (the ledger) and `getAdminUser` (what
 * the admin users table renders) must agree to the cent for a rich ledger. The
 * remaining tests drive the awkward states: CLOSED capital, in-flight payouts,
 * CANCELLED rows, losses larger than capital, late deposits, double deposits and
 * over-withdrawal.
 *
 * Runs against the real PostgreSQL instance; skips loudly (never silently) when
 * the DB is unreachable. Zero fixture residue is asserted in `afterAll`.
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[accounting-adversarial] SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const describeDb = databaseReachable ? describe : describe.skip;
const itDb = databaseReachable ? it : it.skip;

function sessionOf(user: User): SessionUser {
  return toSessionUser(user);
}

/**
 * THE RICH LEDGER (one user, every kind of money row, all totals hand-checked).
 *
 *   deposits      CONFIRMED 9000.00 + FINISHED 250.00          credited = 9250.00
 *                 (PENDING 9999.99 / FAILED 5000.00 never credit)
 *   investments   ACTIVE  7500.00  (unrealizedPnL 88.10, feesDeducted 40.05)
 *                 PAUSED   500.00
 *                 CLOSED   250.00            deployed = 8000.00
 *   trades        CLOSED +310.10, CLOSED −57.25 → realized = 252.85
 *                 OPEN   +999.00 (must never be read)
 *   withdrawals   FINISHED 400.00             paid = 400.00
 *                 PENDING 120.00 + SENDING 30.00 → pending = 150.00
 *                 FAILED  777.00             (never debits, never reserves)
 *
 *   idle            = credited − deployed = 9250.00 − 8000.00   = 1250.00
 *   equity          = 8000.00 + 1250.00 + 252.85 + 88.10 − 40.05 − 400.00
 *                   = 9150.90
 *   netContributed  = 9250.00 − 400.00                          = 8850.00
 *   identity (II)   = 8850.00 + 252.85 + 88.10 − 40.05          = 9150.90  ✓
 *   withdrawable    = max(0, 9150.90 − 8000.00 − 150.00)        = 1000.90
 *   openInvestments = 2 (ACTIVE + PAUSED)
 */
const RICH = {
  credited: '9250.00',
  deployed: '8000.00',
  idle: '1250.00',
  paid: '400.00',
  realized: '252.85',
  unrealized: '88.10',
  fees: '40.05',
  equity: '9150.90',
  netContributed: '8850.00',
  pending: '150.00',
  withdrawable: '1000.90',
  openInvestments: 2,
} as const;

let richUser!: User;
let planId = '';
let brokerId = '';
let richActiveInvestmentId = '';

/** Create an APPROVED client, tagged for cleanup. */
async function scenario(label: string) {
  const user = await createFixtureUser(label);
  return { user, session: sessionOf(user) };
}

async function creditDeposit(
  userId: string,
  amountUsd: string,
  label: string,
  status: PaymentStatus = 'CONFIRMED',
) {
  return prisma.deposit.create({
    data: {
      userId,
      amountUsd,
      cryptoCurrency: 'usdttrc20',
      paymentId: `${FIXTURE_TAG}-payment-${label}-${crypto.randomUUID()}`,
      depositAddress: 'TFixtureAddress',
      payAmount: amountUsd,
      status,
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

describeDb('accounting adversarial probes: can the corrected ledger be broken?', () => {
  beforeAll(async () => {
    await purgeFixtures();

    const broker = await prisma.brokerConnection.create({
      data: {
        metaApiAccountId: fixtureMetaApiAccountId('adversarial'),
        brokerName: 'Fixture Broker',
        environment: 'DEMO',
        maskedAccount: '***-0002',
        balance: '0.00',
        equity: '0.00',
        freeMargin: '0.00',
        status: 'CONNECTED',
      },
    });
    brokerId = broker.id;
    trackBrokerConnection(broker.id);

    const plan = await createFixturePlan('adversarial');
    planId = plan.id;

    richUser = await createFixtureUser('adversarial-rich');

    // ── deposits
    await creditDeposit(richUser.id, '9000.00', 'rich-confirmed', 'CONFIRMED');
    await creditDeposit(richUser.id, '250.00', 'rich-finished', 'FINISHED');
    await creditDeposit(richUser.id, '9999.99', 'rich-pending', 'PENDING');
    await creditDeposit(richUser.id, '5000.00', 'rich-failed', 'FAILED');

    // ── investments
    const active = await prisma.investment.create({
      data: {
        userId: richUser.id,
        planId,
        capitalUsd: '7500.00',
        currentValUsd: '7548.05',
        unrealizedPnL: '88.10',
        feesDeducted: '40.05',
        status: 'ACTIVE',
      },
    });
    richActiveInvestmentId = active.id;
    await prisma.investment.create({
      data: {
        userId: richUser.id,
        planId,
        capitalUsd: '500.00',
        currentValUsd: '500.00',
        status: 'PAUSED',
      },
    });
    await prisma.investment.create({
      data: {
        userId: richUser.id,
        planId,
        capitalUsd: '250.00',
        currentValUsd: '250.00',
        status: 'CLOSED',
      },
    });

    // ── trades
    await closedTrade(active.id, '310.10', 'rich-trade-1');
    await closedTrade(active.id, '-57.25', 'rich-trade-2');
    await prisma.tradeRecord.create({
      data: {
        investmentId: active.id,
        brokerId,
        metaApiPositionId: `${FIXTURE_TAG}-rich-open`,
        instrument: 'XAUUSD',
        direction: 'BUY',
        volume: '1.00',
        entryPrice: '2400.00000',
        netPnL: '999.00',
        grossPnL: '999.00',
        status: 'OPEN',
      },
    });

    // ── withdrawals
    await prisma.withdrawal.create({
      data: {
        userId: richUser.id,
        amountUsd: '400.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutRichFinished',
        status: 'FINISHED',
      },
    });
    await prisma.withdrawal.create({
      data: {
        userId: richUser.id,
        amountUsd: '120.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutRichPending',
        status: 'PENDING',
      },
    });
    await prisma.withdrawal.create({
      data: {
        userId: richUser.id,
        amountUsd: '30.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutRichSending',
        status: 'SENDING',
      },
    });
    await prisma.withdrawal.create({
      data: {
        userId: richUser.id,
        amountUsd: '777.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutRichFailed',
        status: 'FAILED',
      },
    });
  });

  afterAll(async () => {
    if (!databaseReachable) return;
    const report = await purgeFixtures();
    console.log(`[accounting-adversarial] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    const residue = await countFixtureResidue();
    console.log(`[accounting-adversarial] residue after cleanup (must be all zeros):`, residue);
    await assertNoFixtureRowsLeft();
  });

  /* ── 1. THE CROSS-SURFACE TEST ─────────────────────────────────────────── */

  itDb('CROSS-SURFACE: client overview, ledger snapshot and admin row all report 9150.90 for the same account', async () => {
    const snapshot = await getAccountSnapshot(richUser.id);
    const overview = await getOverview(richUser.id);
    const adminRow = await getAdminUser(richUser.id);

    // (a) the three independently-written surfaces agree to the cent
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(RICH.equity);
    expect(overview.equity.toFixed(2), 'client dashboard equity').toBe(RICH.equity);
    expect(adminRow.equity.toFixed(2), 'admin users-table equity').toBe(RICH.equity);

    // (b) and every component of the client DTO matches the ledger's breakdown
    expect(overview.breakdown.startingCapital.toFixed(2)).toBe(RICH.deployed);
    expect(overview.breakdown.confirmedDeposits.toFixed(2)).toBe(RICH.idle);
    expect(overview.breakdown.realizedPnL.toFixed(2)).toBe(RICH.realized);
    expect(overview.breakdown.unrealizedPnL.toFixed(2)).toBe(RICH.unrealized);
    expect(overview.breakdown.deductedFees.toFixed(2)).toBe(RICH.fees);
    expect(overview.breakdown.withdrawals.toFixed(2)).toBe(RICH.paid);
    expect(overview.breakdown.netContributedCapital.toFixed(2)).toBe(RICH.netContributed);
    expect(overview.breakdown.totalCreditedDeposits.toFixed(2)).toBe(RICH.credited);
    expect(overview.breakdown.totalPaidWithdrawals.toFixed(2)).toBe(RICH.paid);
    expect(overview.activeCapital.toFixed(2)).toBe(RICH.deployed);
    expect(overview.pendingWithdrawals.toFixed(2)).toBe(RICH.pending);
    expect(overview.withdrawableBalance.toFixed(2)).toBe(RICH.withdrawable);

    // (c) the admin row's capital is the ledger's deployed figure too
    expect(adminRow.capitalUsd.toFixed(2)).toBe(RICH.deployed);
    expect(adminRow.role).toBe('CLIENT');

    // (d) the OPEN trade's 999.00 is nowhere in realized P/L or equity
    expect(overview.breakdown.realizedPnL.toFixed(2)).not.toBe('1251.85');
    expect(overview.equity.toFixed(2)).not.toBe('10149.90');

    // (e) no NaN in a money field, whatever the state
    for (const value of [
      overview.equity,
      overview.netProfit,
      overview.netReturnPct,
      overview.grossPnL,
      overview.breakdown.netContributedCapital,
      overview.withdrawableBalance,
    ]) {
      expect(Number.isFinite(value), `money field is finite: ${value}`).toBe(true);
    }
  });

  itDb('PLATFORM: getPlatformLedger() equals the same formula applied to platform-wide aggregates', async () => {
    const readAggregates = async () => {
      const [credited, paid, deployed, closed, portfolio] = await Promise.all([
        prisma.deposit.aggregate({
          where: { status: { in: ['CONFIRMED', 'FINISHED'] } },
          _sum: { amountUsd: true },
        }),
        prisma.withdrawal.aggregate({ where: { status: 'FINISHED' }, _sum: { amountUsd: true } }),
        prisma.investment.aggregate({
          where: { status: { in: ['ACTIVE', 'PAUSED'] } },
          _sum: { capitalUsd: true },
        }),
        prisma.tradeRecord.aggregate({ where: { status: 'CLOSED' }, _sum: { netPnL: true } }),
        prisma.investment.aggregate({ _sum: { unrealizedPnL: true, feesDeducted: true } }),
      ]);
      return { credited, paid, deployed, closed, portfolio };
    };

    // Platform-wide totals are shared state: other test files (and any deployed
    // app process) can write rows between two queries. Read the ledger, the raw
    // aggregates and the ledger AGAIN, and only assert on a window in which the
    // platform total did not move — otherwise the comparison would be measuring
    // "two different moments", not a formula mismatch.
    //
    // The window must watch ALL THREE of equity, managed capital and gross
    // credited: a deployment moves `deployed` and idle by equal and opposite
    // amounts, so it leaves `totalEquity` and `confirmedDeposits` untouched
    // while `totalManagedCapital` still moves (observed as a false failure with
    // a sibling test file writing investments in parallel). With all three
    // pinned at both edges of the aggregate read, every kind of ledger write
    // (deposit, payout, deployment, closed trade, cancellation) changes at
    // least one of them.
    let ledger = await getPlatformLedger();
    let agg = await readAggregates();
    let stable = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const confirmed = await getPlatformLedger();
      agg = await readAggregates();
      const after = await getPlatformLedger();
      if (
        confirmed.totalEquity.eq(after.totalEquity) &&
        confirmed.totalManagedCapital.eq(after.totalManagedCapital) &&
        confirmed.confirmedDeposits.eq(after.confirmedDeposits) &&
        confirmed.withdrawalsPaid.eq(after.withdrawalsPaid) &&
        confirmed.realizedPnL.eq(after.realizedPnL) &&
        confirmed.unrealizedPnL.eq(after.unrealizedPnL) &&
        confirmed.deductedFees.eq(after.deductedFees)
      ) {
        ledger = after;
        stable = true;
        break;
      }
      ledger = after;
    }
    if (!stable) {
      console.warn(
        '[accounting-adversarial] platform ledger never reached a stable window — the database is being written continuously; formula assertion skipped.',
      );
      return;
    }

    const independent = D(agg.credited._sum.amountUsd)
      .minus(D(agg.paid._sum.amountUsd))
      .plus(D(agg.closed._sum.netPnL))
      .plus(D(agg.portfolio._sum.unrealizedPnL))
      .minus(D(agg.portfolio._sum.feesDeducted));

    expect(ledger.totalEquity.toFixed(2), 'platform AUM equity').toBe(independent.toFixed(2));
    expect(ledger.totalManagedCapital.toFixed(2)).toBe(D(agg.deployed._sum.capitalUsd).toFixed(2));
    expect(ledger.confirmedDeposits.toFixed(2)).toBe(D(agg.credited._sum.amountUsd).toFixed(2));
    expect(ledger.withdrawalsPaid.toFixed(2)).toBe(D(agg.paid._sum.amountUsd).toFixed(2));

    // The platform total is the per-account formula, so a drifting client view
    // would show up here as a mismatch with its own platform sum.
    const { equity: fromAggregates } = buildEquityFromAggregates({
      creditedDeposits: D(agg.credited._sum.amountUsd),
      paidWithdrawals: D(agg.paid._sum.amountUsd),
      deployedCapital: D(agg.deployed._sum.capitalUsd),
      realizedPnL: D(agg.closed._sum.netPnL),
      unrealizedPnL: D(agg.portfolio._sum.unrealizedPnL),
      deductedFees: D(agg.portfolio._sum.feesDeducted),
    });
    expect(ledger.totalEquity.toFixed(2)).toBe(fromAggregates.toFixed(2));

    // The platform's gross-credited figure is the SAME quantity the client view
    // calls totalCreditedDeposits — one name per number, no re-definition.
    expect(ledger.confirmedDeposits.toFixed(2)).toBe(D(agg.credited._sum.amountUsd).toFixed(2));
  });

  /* ── 2. CLOSED capital, in-flight payouts ──────────────────────────────── */

  itDb('CLOSED investment: equity does not move, its capital just stops being locked', async () => {
    const before = await getAccountSnapshot(richUser.id);
    expect(before.breakdown.equity.toFixed(2)).toBe(RICH.equity);
    expect(before.withdrawableBalance.toFixed(2)).toBe(RICH.withdrawable);

    await prisma.investment.update({ where: { id: richActiveInvestmentId }, data: { status: 'CLOSED' } });
    try {
      const after = await getAccountSnapshot(richUser.id);
      // deployed 8000.00 → 500.00 (the PAUSED row); idle 1250.00 → 8750.00
      // equity = 500.00 + 8750.00 + 252.85 + 88.10 − 40.05 − 400.00 = 9150.90 (unchanged)
      expect(after.breakdown.equity.toFixed(2)).toBe(RICH.equity);
      expect(after.breakdown.startingCapital.toFixed(2)).toBe('500.00');
      expect(after.breakdown.confirmedDeposits.toFixed(2)).toBe('8750.00');
      expect(after.breakdown.startingCapital.plus(after.breakdown.confirmedDeposits).toFixed(2)).toBe(
        RICH.credited,
      );
      expect(after.openInvestments).toBe(1);
      // ...and the released capital is now WITHDRAWABLE:
      // max(0, 9150.90 − 500.00 − 150.00) = 8500.90
      expect(after.withdrawableBalance.toFixed(2)).toBe('8500.90');
      // (the honest consequence: closing an investment does not create money,
      //  it changes what is spendable — which is exactly the point of the
      //  withdrawable-balance rule.)
    } finally {
      await prisma.investment.update({ where: { id: richActiveInvestmentId }, data: { status: 'ACTIVE' } });
    }
    expect((await getAccountSnapshot(richUser.id)).breakdown.equity.toFixed(2)).toBe(RICH.equity);
  });

  itDb('IN-FLIGHT withdrawal: excluded from equity, included in pendingWithdrawals, never both', async () => {
    const snapshot = await getAccountSnapshot(richUser.id);
    // equity only debits FINISHED: paid = 400.00, not 400.00 + 150.00
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe('400.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(RICH.equity);
    // ...while the reservation is reported, so it can still be refused twice
    expect(snapshot.pendingWithdrawals.toFixed(2)).toBe(RICH.pending);
    // disjointness: the in-flight rows are NOT inside the equity debit
    expect(snapshot.breakdown.withdrawals.toFixed(2)).not.toBe('550.00');
    // and the reservation really binds: withdrawing the full free balance is OK,
    // one cent more is not. (Asserted on the boundary, below.)

    // Now settle the 120.00 PENDING row and watch equity move by exactly 120.00.
    const pending = await prisma.withdrawal.findFirst({
      where: { userId: richUser.id, status: 'PENDING' },
      orderBy: { amountUsd: 'asc' },
    });
    expect(pending).not.toBeNull();
    await prisma.withdrawal.update({ where: { id: pending!.id }, data: { status: 'FINISHED' } });
    try {
      const after = await getAccountSnapshot(richUser.id);
      // paid 400.00 + 120.00 = 520.00; equity 9150.90 − 120.00 = 9030.90
      expect(after.breakdown.withdrawals.toFixed(2)).toBe('520.00');
      expect(after.breakdown.equity.toFixed(2)).toBe('9030.90');
      expect(D(snapshot.breakdown.equity).minus(D(after.breakdown.equity)).toFixed(2)).toBe('120.00');
      // the reservation shrinks by the same amount; the two surfaces move together
      expect(after.pendingWithdrawals.toFixed(2)).toBe('30.00');
      // max(0, 9030.90 − 8000.00 − 30.00) = 1000.90
      expect(after.withdrawableBalance.toFixed(2)).toBe('1000.90');
    } finally {
      await prisma.withdrawal.update({ where: { id: pending!.id }, data: { status: 'PENDING' } });
    }
    expect((await getAccountSnapshot(richUser.id)).breakdown.equity.toFixed(2)).toBe(RICH.equity);
  });

  /* ── 3. Honesty under loss, and the withdrawal boundary ────────────────── */

  itDb('NEGATIVE equity: losses larger than the capital are reported honestly, never clamped', async () => {
    const { user, session } = await scenario('negative');
    await creditDeposit(user.id, '1000.00', 'negative-dep');
    const investment = await prisma.investment.create({
      data: {
        userId: user.id,
        planId,
        capitalUsd: '1000.00',
        currentValUsd: '1000.00',
        status: 'ACTIVE',
      },
    });
    await closedTrade(investment.id, '-5000.00', 'negative-loss');

    // credited 1000.00 − paid 0.00 + realized −5000.00 = −4000.00
    const snapshot = await getAccountSnapshot(user.id);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('-4000.00');
    expect(snapshot.breakdown.equity.isNegative()).toBe(true);
    expect(snapshot.netContributedCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe('-5000.00');
    expect(snapshot.breakdown.netProfit.toFixed(2)).toBe('-5000.00');
    // "return on the money I put in": −5000 / 1000 = −500%
    expect(snapshot.breakdown.netReturnPct.toFixed(4)).toBe('-500.0000');

    // The only thing that is floored is what can be TAKEN OUT — never the truth
    // about what the account is worth.
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');

    // ...and the client-facing DTO says the same honest thing.
    const overview = await getOverview(user.id);
    expect(overview.equity.toFixed(2)).toBe('-4000.00');
    expect(overview.equity).toBeLessThan(0);
    expect(overview.netProfit.toFixed(2)).toBe('-5000.00');

    // A withdraw request on an underwater account is refused.
    await expect(
      requestWithdrawal({
        user: session,
        amountUsd: 1,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
  });

  itDb('OVER-WITHDRAWAL boundary: the exact withdrawable cents succeed, one cent more is refused', async () => {
    const { user, session } = await scenario('boundary');
    await creditDeposit(user.id, '2000.00', 'boundary-dep');
    const investment = await prisma.investment.create({
      data: { userId: user.id, planId, capitalUsd: '1500.00', currentValUsd: '1500.00', status: 'ACTIVE' },
    });
    await closedTrade(investment.id, '100.00', 'boundary-profit');

    // credited 2000.00, deployed 1500.00, idle 500.00, realized 100.00
    // equity = 1500.00 + 500.00 + 100.00 = 2100.00
    // withdrawable = max(0, 2100.00 − 1500.00 − 0.00) = 600.00
    const snapshot = await getAccountSnapshot(user.id);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('2100.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('600.00');

    // one cent over → refused, nothing persisted
    await expect(
      requestWithdrawal({
        user: session,
        amountUsd: 600.01,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);

    // exactly the free balance → accepted, and it is RESERVED, not spent
    const accepted = await requestWithdrawal({
      user: session,
      amountUsd: 600,
      cryptoCurrency: 'usdttrc20',
      payoutAddress: TRON_PAYOUT_ADDRESS,
      ip: null,
    });
    expect(accepted.status).toBe('PENDING');
    const after = await getAccountSnapshot(user.id);
    expect(after.breakdown.equity.toFixed(2)).toBe('2100.00'); // unchanged: not paid yet
    expect(after.pendingWithdrawals.toFixed(2)).toBe('600.00');
    expect(after.withdrawableBalance.toFixed(2)).toBe('0.00');

    // and a second identical request is now refused (the reserve binds)
    await expect(
      requestWithdrawal({
        user: session,
        amountUsd: 600,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  /* ── 4. Deposits arriving in awkward orders ───────────────────────────── */

  itDb('TWO deposits: each credits exactly once (the double-count cannot come back)', async () => {
    const { user } = await scenario('two-deposits');
    await creditDeposit(user.id, '300.00', 'two-a', 'CONFIRMED');
    const afterFirst = await getAccountSnapshot(user.id);
    expect(afterFirst.breakdown.equity.toFixed(2)).toBe('300.00');
    expect(afterFirst.breakdown.confirmedDeposits.toFixed(2)).toBe('300.00');
    expect(afterFirst.breakdown.startingCapital.toFixed(2)).toBe('0.00');

    await creditDeposit(user.id, '700.00', 'two-b', 'FINISHED');
    const afterSecond = await getAccountSnapshot(user.id);
    // 300.00 + 700.00 = 1000.00 — never 300.00 + 1000.00
    expect(afterSecond.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(D(afterSecond.breakdown.equity).minus(D(afterFirst.breakdown.equity)).toFixed(2)).toBe('700.00');
    expect(afterSecond.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00');
    expect(afterSecond.totalCreditedDeposits.toFixed(2)).toBe('1000.00');

    // ...and the row count is exactly two, so nothing was duplicated
    expect(await prisma.deposit.count({ where: { userId: user.id } })).toBe(2);
  });

  itDb('LATE deposit after the capital was deployed double-counts nothing (and the clamp is honest)', async () => {
    const { user } = await scenario('late-deposit');

    // An investment recorded against capital that has not been credited yet.
    // `createInvestment` cannot produce this state (its gate is the withdrawable
    // balance) — it is the shape a legacy/imported row or a future admin path
    // could have, so the ledger must stay SAFE in it.
    await prisma.investment.create({
      data: { userId: user.id, planId, capitalUsd: '1000.00', currentValUsd: '1000.00', status: 'ACTIVE' },
    });

    const unfunded = await getAccountSnapshot(user.id);
    // deployed 1000.00, credited 0.00 → the idle term would be NEGATIVE, so it is
    // clamped to 0 and ledger.ts logs the inconsistency instead of reporting a
    // negative idle bucket. equity = 1000.00 + 0.00 = 1000.00
    expect(unfunded.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(unfunded.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(unfunded.netContributedCapital.toFixed(2)).toBe('0.00');
    // DOCUMENTED LIMITATION: identity (II) does NOT hold in this unfunded state
    // (equity counts deployed capital that was never credited). It is not a
    // fabrication — nothing is inflated above what is deployed — and the state is
    // unreachable through the real services, but it is why the fixture suite
    // asserts (II) only for funded accounts.
    expect(unfunded.breakdown.equity.isNegative()).toBe(false);

    // Now the money arrives. Equity must NOT jump by the deposit again: the
    // deployed dollar was already counted, so this only re-labels it as funded.
    await creditDeposit(user.id, '1000.00', 'late-dep');
    const funded = await getAccountSnapshot(user.id);
    expect(funded.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(funded.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
    expect(funded.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(funded.netContributedCapital.toFixed(2)).toBe('1000.00');
    // after funding, both identities hold again
    expect(funded.breakdown.equity.toFixed(2)).toBe(
      funded.netContributedCapital
        .plus(funded.breakdown.realizedPnL)
        .plus(funded.breakdown.unrealizedPnL)
        .minus(funded.breakdown.deductedFees)
        .toFixed(2),
    );
  });

  /* ── 5. CANCELLED investment: both surfaces must exclude it ────────────── */

  itDb('CANCELLED investment: neither surface locks its capital (the reachable contract holds)', async () => {
    const { user } = await scenario('cancelled-clean');
    await creditDeposit(user.id, '1000.00', 'cancelled-clean-dep');
    await prisma.investment.create({
      data: { userId: user.id, planId, capitalUsd: '400.00', currentValUsd: '400.00', status: 'CANCELLED' },
    });

    // credited 1000.00, deployed 0.00 (CANCELLED is not deployed) → idle 1000.00
    const snapshot = await getAccountSnapshot(user.id);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00');
    expect(snapshot.activeCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.openInvestments).toBe(0);
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('1000.00');

    // ...and the admin surface agrees for this shape
    const adminRow = await getAdminUser(user.id);
    expect(adminRow.capitalUsd.toFixed(2)).toBe('0.00');
    expect(adminRow.equity.toFixed(2)).toBe('1000.00');
  });

  itDb('CANCELLED row with fees/unrealized P/L (D5 FIXED): client ledger and admin row must be EQUAL', async () => {
    const { user } = await scenario('cancelled-divergent');
    await creditDeposit(user.id, '1000.00', 'cancelled-divergent-dep');
    const cancelled = await prisma.investment.create({
      data: {
        userId: user.id,
        planId,
        capitalUsd: '400.00',
        currentValUsd: '400.00',
        // A cancelled investment shouldn't have these, but nothing in the schema
        // forbids them, and a partial sync could leave them behind.
        unrealizedPnL: '5.00',
        feesDeducted: '12.34',
        status: 'CANCELLED',
      },
    });

    // The bogus figures really are on the row — so this test proves EXCLUSION,
    // not merely that the fixture happened to be empty.
    const persisted = await prisma.investment.findUniqueOrThrow({ where: { id: cancelled.id } });
    expect(D(persisted.unrealizedPnL).toFixed(2)).toBe('5.00');
    expect(D(persisted.feesDeducted).toFixed(2)).toBe('12.34');

    const snapshot = await getAccountSnapshot(user.id);
    const adminRow = await getAdminUser(user.id);

    // CORRECTED ARITHMETIC (D5 fix): `ledger.ts` filters `status: { not:
    // 'CANCELLED' }` on the unrealizedPnL/feesDeducted aggregate in BOTH the
    // per-user snapshot and the platform ledger, matching the admin projection
    // (admin.service.ts:portfolioTotals). A CANCELLED investment is not
    // deployed (its 400.00 is already excluded from startingCapital by the
    // ACTIVE/PAUSED filter), so it must also contribute no P/L and no fees:
    //
    //   credited  = 1000.00 (CONFIRMED)
    //   deployed  = 0.00    (CANCELLED is not ACTIVE/PAUSED)
    //   idle      = credited − deployed                          = 1000.00
    //   equity    = 0.00 + 1000.00 + 0.00 + 0.00 − 0.00 − 0.00   = 1000.00
    //
    // Neither the 5.00 unrealized nor the 12.34 fees is counted, on EITHER
    // surface. The old defect was client 992.66 vs admin 1000.00 (a 7.34 gap).
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.deductedFees.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');

    expect(adminRow.equity.toFixed(2)).toBe('1000.00');
    expect(adminRow.capitalUsd.toFixed(2)).toBe('0.00');

    // THE CONTRACT: identical to the cent, and the old divergences are gone.
    expect(adminRow.equity.toFixed(2)).toBe(snapshot.breakdown.equity.toFixed(2));
    expect(D(adminRow.equity).minus(D(snapshot.breakdown.equity)).toFixed(2)).toBe('0.00');
    // the buggy client value (counted the cancelled row) and the old gap:
    expect(snapshot.breakdown.equity.toFixed(2)).not.toBe('992.66');
    expect(D(adminRow.equity).minus(D(snapshot.breakdown.equity)).toFixed(2)).not.toBe('7.34');

    // ...and the client-facing DTO agrees too (a third surface on the same row).
    const overview = await getOverview(user.id);
    expect(overview.equity.toFixed(2)).toBe('1000.00');
    expect(overview.breakdown.unrealizedPnL.toFixed(2)).toBe('0.00');
    expect(overview.breakdown.deductedFees.toFixed(2)).toBe('0.00');
    expect(overview.withdrawableBalance.toFixed(2)).toBe('1000.00');
  });

  /* ── 6. Strategy stats: no invented track record ───────────────────────── */

  itDb('strategy-stats: no closed trades ⇒ null (never a placeholder); the denominator is capital that actually traded', async () => {
    const { user } = await scenario('stats');
    const plan = await createFixturePlan('stats');

    // Directive #1/#2: with zero history there is no win rate, so the honest
    // answer is null — never 0% and never 100%.
    expect(await getStrategyStats(plan.id, { fresh: true })).toBeNull();

    const active = await prisma.investment.create({
      data: { userId: user.id, planId: plan.id, capitalUsd: '1000.00', currentValUsd: '1000.00', status: 'ACTIVE' },
    });
    await prisma.investment.create({
      data: { userId: user.id, planId: plan.id, capitalUsd: '3000.00', currentValUsd: '3000.00', status: 'CLOSED' },
    });
    await closedTrade(active.id, '200.00', 'stats-win');
    await closedTrade(active.id, '-50.00', 'stats-loss');

    const stats = await getStrategyStats(plan.id, { fresh: true });
    expect(stats).not.toBeNull();
    expect(stats!.closedTrades).toBe(2);
    expect(stats!.winningTrades).toBe(1);
    expect(stats!.losingTrades).toBe(1);
    expect(stats!.winRatePct).toBe(50);
    expect(stats!.netPnL).toBe(150);
    expect(stats!.grossProfit).toBe(200);
    expect(stats!.grossLoss).toBe(50);

    // CORRECTED ARITHMETIC (denominator fix): `strategy-stats.ts` now scopes the
    // denominator to investments that have `trades: { some: { status: 'CLOSED' } }`
    // — the capital that actually produced the closed trades.
    //
    //   the 1000.00 ACTIVE investment holds BOTH closed trades (+200.00, −50.00)
    //     ⇒ it is the only investment in the denominator
    //   the 3000.00 CLOSED investment never traded ⇒ it is EXCLUDED (its capital
    //     is no longer at risk at all)
    //
    //   net P/L          = +200.00 − 50.00                          =  150.00
    //   denominator      = 1000.00 (not 1000.00 + 3000.00 = 4000.00)
    //   observedReturn   = 150.00 / 1000.00 × 100                  =   15.0000 %
    //   maxDrawdown      = peak 200.00 → trough 150.00 = 50.00
    //                    = 50.00 / 1000.00 × 100                    =    5.0000 %
    //
    // The old code reported 150.00 / 4000.00 = 3.7500 % — a 4× understatement
    // of a public performance claim, which is the number that must NOT come back.
    expect(stats!.observedReturnPct).toBe(15);
    expect(stats!.observedReturnPct).not.toBe(3.75);
    expect(stats!.maxObservedDrawdownPct).toBe(5);
    expect(stats!.maxObservedDrawdownPct).not.toBe(1.25);
    expect(stats!.indicativeOnly).toBe(true);
    expect(Number.isFinite(stats!.observedReturnPct!)).toBe(true);
    expect(stats!.maxObservedDrawdownPct).not.toBeNull();
  });

  /* ── 7. Pure-function cross-check (no DB) ─────────────────────────────── */

  it('computeEquity and buildEquityFromAggregates agree on the same underlying rows', () => {
    const rows = {
      creditedDeposits: RICH.credited,
      paidWithdrawals: RICH.paid,
      deployedCapital: RICH.deployed,
      realizedPnL: RICH.realized,
      unrealizedPnL: RICH.unrealized,
      deductedFees: RICH.fees,
    };
    const assembled = buildEquityFromAggregates(rows);
    const direct = computeEquity({
      startingCapital: RICH.deployed,
      confirmedDeposits: D(RICH.credited).minus(D(RICH.deployed)),
      realizedPnL: RICH.realized,
      unrealizedPnL: RICH.unrealized,
      deductedFees: RICH.fees,
      withdrawals: RICH.paid,
    });
    expect(assembled.equity.toFixed(2)).toBe(RICH.equity);
    expect(direct.equity.toFixed(2)).toBe(RICH.equity);
    expect(assembled.equity.toFixed(2)).toBe(direct.equity.toFixed(2));
    // withdrawing 400.00 must cost the client 400.00, not 800.00
    expect(assembled.equity.toFixed(2)).not.toBe('8750.90');
  });
});
