import './helpers/test-env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { D } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { createInvestment } from '@/server/modules/account/account.service';
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

/**
 * MONEY-PATH RACES — check-then-act in the two places that move money.
 *
 * The ledger ARITHMETIC is correct (proved elsewhere in this suite). These
 * probes attack the GUARDS: `requestWithdrawal` and `createInvestment` both
 * read `getAccountSnapshot().withdrawableBalance` and then INSERT. That is a
 * check-then-act pattern, so the only thing standing between two concurrent
 * requests and an over-reservation is the critical section around it — and it
 * must be a real one: an interactive transaction that takes `SELECT id FROM
 * "User" WHERE id = $1 FOR UPDATE` BEFORE reading the snapshot, with the
 * snapshot read through the TRANSACTION client. The `tx` argument is not
 * cosmetic: the snapshot queries must ride the connection that already holds
 * the lock. Passing the global `prisma` would leave the lock-holder asking the
 * pool for a second connection while holding one, so a 10-way burst can time
 * out the pool (P2024) instead of serialising — the exact-count assertions
 * below (every rejection must be `INSUFFICIENT_FUNDS`) catch that too.
 *
 * History — both holes were REAL and verified on the live database:
 *
 *   * D7 (withdrawal) — N concurrent requests over-reserve the account. The
 *     reservations are what the admin approves, so the platform can be made to
 *     pay out more than the client had free. Observed: 600.00 free, a burst of
 *     parallel 600.00 requests → up to 4800.00 reserved.
 *   * D8 (investment) — N concurrent investments over-deploy the account,
 *     putting the ledger into the `deployed > credited` state that
 *     `buildEquityFromAggregates` itself logs as an inconsistency, and where
 *     equity identity (II) no longer holds. Observed: 1000.00 credited, parallel
 *     1000.00 investments → 2000.00+ deployed.
 *
 * Both were quarantined as `it.fails` while the hole was open. The owner fixed
 * both in `src/` with the interactive-transaction + row-lock pattern, so the
 * bodies now assert the CORRECT contract and are promoted to plain `it(...)`
 * tests — exactly like the D1/D2/D3 ratchets were. Nothing was weakened: the
 * promoted bodies are STRONGER than the quarantines they replace, because a
 * fixed guard must be pinned with exact arithmetic, not merely "no overflow".
 *
 * Each promoted test therefore asserts, on a deliberate 8-way burst:
 *
 *   * EXACTLY the arithmetically correct number of successes, not just ≤ 1 —
 *     e.g. 8 × 200.00 against 600.00 free must yield 3 successes, which also
 *     proves the lock SERIALISES rather than rejecting everything after the
 *     first request;
 *   * every rejection carries `INSUFFICIENT_FUNDS` (no connection-pool or
 *     transaction-timeout error being mistaken for a correct refusal);
 *   * the Σ of accepted reservations / deployments is exactly the pre-race
 *     balance, so the sum can never exceed it by a cent;
 *   * `deployed <= credited` still holds afterwards;
 *   * a PENDING reservation never moves equity.
 *
 * CONCURRENCY DISCIPLINE: the burst is fired with `Promise.allSettled` and no
 * `await` between the calls, so all N requests are in flight together. Under
 * the fix the run is deterministic (the user row lock orders them); if the lock
 * is ever removed, N parallel read-then-writes over-reserve again and the exact
 * counts below go red.
 *
 * Runs against the real PostgreSQL instance; skips loudly when unreachable.
 * Zero fixture residue is asserted in `afterAll`.
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[money-path-races] SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const describeDb = databaseReachable ? describe : describe.skip;
const itDb = databaseReachable ? it : it.skip;

let planId = '';
let brokerId = '';

async function makeClient(label: string): Promise<{ userId: string; session: SessionUser }> {
  const user = await createFixtureUser(label);
  return { userId: user.id, session: toSessionUser(user) };
}

async function creditDeposit(userId: string, amountUsd: string, label: string) {
  await prisma.deposit.create({
    data: {
      userId,
      amountUsd,
      cryptoCurrency: 'usdttrc20',
      paymentId: `${FIXTURE_TAG}-payment-${label}`,
      depositAddress: 'TFixtureAddress',
      payAmount: amountUsd,
      status: 'CONFIRMED',
    },
  });
}

/** A CLOSED trade, so a client has some free profit to withdraw. */
async function bookProfit(investmentId: string, netPnL: string, label: string) {
  await prisma.tradeRecord.create({
    data: {
      investmentId,
      brokerId,
      derivContractId: `${FIXTURE_TAG}-${label}`,
      instrument: 'XAUUSD',
      direction: 'BUY',
      volume: '0.10',
      entryPrice: '2400.00000',
      exitPrice: '2402.50000',
      grossPnL: netPnL,
      netPnL,
      status: 'CLOSED',
      closedAt: new Date('2026-09-22T09:00:00.000Z'),
    },
  });
}

describeDb('money-path races: concurrent check-then-act on withdrawableBalance', () => {
  beforeEach(async () => {
    if (planId) return;
    const broker = await prisma.brokerConnection.create({
      data: {
        derivAccountId: fixtureMetaApiAccountId('races'),
        brokerName: 'Fixture Broker',
        environment: 'DEMO',
        maskedAccount: '***-0003',
        balance: '0.00',
        equity: '0.00',
        freeMargin: '0.00',
        status: 'CONNECTED',
      },
    });
    brokerId = broker.id;
    trackBrokerConnection(broker.id);
    planId = (await createFixturePlan('races')).id;
  });

  afterAll(async () => {
    if (!databaseReachable) return;
    const report = await purgeFixtures();
    console.log(`[money-path-races] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    const residue = await countFixtureResidue();
    console.log(`[money-path-races] residue after cleanup (must be all zeros):`, residue);
    await assertNoFixtureRowsLeft();
  });

  itDb('the withdrawal ceiling is enforced when requests are SERIAL (the guard itself works)', async () => {
    const { userId, session } = await makeClient('race-serial');
    await creditDeposit(userId, '2000.00', 'race-serial-dep');
    const investment = await prisma.investment.create({
      data: { userId, planId, capitalUsd: '1500.00', currentValUsd: '1500.00', status: 'ACTIVE' },
    });
    await bookProfit(investment.id, '100.00', 'race-serial-profit');

    // equity 2100.00 − deployed 1500.00 = 600.00 free
    expect((await getAccountSnapshot(userId)).withdrawableBalance.toFixed(2)).toBe('600.00');

    const first = await requestWithdrawal({
      user: session,
      amountUsd: 600,
      cryptoCurrency: 'usdttrc20',
      payoutAddress: TRON_PAYOUT_ADDRESS,
      ip: null,
    });
    expect(first.status).toBe('PENDING');

    // Serial: the reserve is visible to the next request, so it is refused.
    await expect(
      requestWithdrawal({
        user: session,
        amountUsd: 600,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    const reserved = await prisma.withdrawal.aggregate({
      where: { userId, status: { in: ['PENDING', 'WAITING', 'CONFIRMED', 'SENDING'] } },
      _sum: { amountUsd: true },
    });
    expect(D(reserved._sum.amountUsd).toFixed(2)).toBe('600.00');
  });

  /* ── D7 — FIXED: concurrent withdrawals ─────────────────────────────────── */

  itDb('D7 FIXED: concurrent withdrawals never over-reserve — exactly one full-balance burst succeeds', async () => {
    const BURST = 8;
    const FREE = '600.00';

    const { userId, session } = await makeClient('race-withdraw');
    await creditDeposit(userId, '2000.00', 'race-withdraw-dep');
    const investment = await prisma.investment.create({
      data: { userId, planId, capitalUsd: '1500.00', currentValUsd: '1500.00', status: 'ACTIVE' },
    });
    await bookProfit(investment.id, '100.00', 'race-withdraw-profit');

    // equity 2100.00 − deployed 1500.00 = 600.00 free
    const before = await getAccountSnapshot(userId);
    expect(before.withdrawableBalance.toFixed(2)).toBe(FREE);
    const equityBefore = before.breakdown.equity.toFixed(2);

    const reserve = async () =>
      prisma.withdrawal.aggregate({
        where: { userId, status: { in: ['PENDING', 'WAITING', 'CONFIRMED', 'SENDING'] } },
        _sum: { amountUsd: true },
      });

    // Fire all 8 with no await between them: every one is in flight together.
    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        requestWithdrawal({
          user: session,
          amountUsd: 600,
          cryptoCurrency: 'usdttrc20',
          payoutAddress: TRON_PAYOUT_ADDRESS,
          ip: null,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // THE CONTRACT (exact counts): the balance covers exactly ONE of these.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(BURST - 1);
    // ...and every refusal is the guard, not a pool timeout / deadlock surfacing
    // as a rejection and being mistaken for a correct refusal.
    expect(rejected.map((r) => (r.reason as { code?: string } | undefined)?.code)).toEqual(
      Array.from({ length: BURST - 1 }, () => 'INSUFFICIENT_FUNDS'),
    );

    // Σ accepted reservations === the free balance, never freeBalance × successes
    const reserved = D((await reserve())._sum.amountUsd);
    expect(reserved.toFixed(2)).toBe(FREE);
    expect(reserved.lessThanOrEqualTo(FREE)).toBe(true);

    // The ledger is honest about the one reservation it accepted: a PENDING row
    // never moves equity, it only reduces what may be asked for next.
    const after = await getAccountSnapshot(userId);
    expect(after.breakdown.equity.toFixed(2)).toBe(equityBefore);
    expect(after.pendingWithdrawals.toFixed(2)).toBe(FREE);
    expect(after.withdrawableBalance.toFixed(2)).toBe('0.00');
    expect(await prisma.withdrawal.count({ where: { userId } })).toBe(1);
  });

  itDb('D7 FIXED: a burst of partial requests reserves exactly the balance — 8 × 200.00 against 600.00 free gives 3 wins', async () => {
    const BURST = 8;
    const FREE = '600.00';

    const { userId, session } = await makeClient('race-withdraw-partial');
    await creditDeposit(userId, '2000.00', 'race-withdraw-partial-dep');
    const investment = await prisma.investment.create({
      data: { userId, planId, capitalUsd: '1500.00', currentValUsd: '1500.00', status: 'ACTIVE' },
    });
    await bookProfit(investment.id, '100.00', 'race-withdraw-partial-profit');
    expect((await getAccountSnapshot(userId)).withdrawableBalance.toFixed(2)).toBe(FREE);

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        requestWithdrawal({
          user: session,
          amountUsd: 200,
          cryptoCurrency: 'usdttrc20',
          payoutAddress: TRON_PAYOUT_ADDRESS,
          ip: null,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // 600.00 / 200.00 = 3 — the lock must serialise, NOT reject everything after
    // the first request (that would be a broken guard hiding behind "no overflow").
    expect(fulfilled.length).toBe(3);
    expect(rejected.length).toBe(BURST - 3);
    expect(rejected.every((r) => (r.reason as { code?: string } | undefined)?.code === 'INSUFFICIENT_FUNDS')).toBe(
      true,
    );

    const reserved = await prisma.withdrawal.aggregate({
      where: { userId, status: { in: ['PENDING', 'WAITING', 'CONFIRMED', 'SENDING'] } },
      _sum: { amountUsd: true },
    });
    expect(D(reserved._sum.amountUsd).toFixed(2)).toBe(FREE);

    const after = await getAccountSnapshot(userId);
    expect(after.pendingWithdrawals.toFixed(2)).toBe(FREE);
    expect(after.withdrawableBalance.toFixed(2)).toBe('0.00');
  });

  /* ── D8 — FIXED: concurrent investments ────────────────────────────────── */

  itDb('D8 FIXED: concurrent investments never over-deploy — deployed ≤ credited after the race', async () => {
    const BURST = 8;

    const { userId, session } = await makeClient('race-invest');
    await creditDeposit(userId, '1000.00', 'race-invest-dep');
    expect((await getAccountSnapshot(userId)).withdrawableBalance.toFixed(2)).toBe('1000.00');

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () => createInvestment({ user: session, planId, amountUsd: 1000, ip: null })),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(BURST - 1);
    expect(rejected.map((r) => (r.reason as { code?: string } | undefined)?.code)).toEqual(
      Array.from({ length: BURST - 1 }, () => 'INSUFFICIENT_FUNDS'),
    );

    const deployed = await prisma.investment.aggregate({
      where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } },
      _sum: { capitalUsd: true },
    });
    const credited = await prisma.deposit.aggregate({
      where: { userId, status: { in: ['CONFIRMED', 'FINISHED'] } },
      _sum: { amountUsd: true },
    });

    // THE CONTRACT: never deploy more than was available.
    expect(D(deployed._sum.capitalUsd).toFixed(2)).toBe('1000.00');
    expect(D(deployed._sum.capitalUsd).lessThanOrEqualTo(D(credited._sum.amountUsd))).toBe(true);
    expect(await prisma.investment.count({ where: { userId } })).toBe(1);

    // ...and therefore the equity identity holds:
    //   equity 1000.00 = netContributed 1000.00 + 0 P/L
    const snapshot = await getAccountSnapshot(userId);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(
      snapshot.netContributedCapital
        .plus(snapshot.breakdown.realizedPnL)
        .plus(snapshot.breakdown.unrealizedPnL)
        .minus(snapshot.breakdown.deductedFees)
        .toFixed(2),
    );
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
  });

  itDb('D8 FIXED: a burst of partial investments deploys exactly the credited balance — 8 × 250.00 against 1000.00 gives 4', async () => {
    const BURST = 8;

    const { userId, session } = await makeClient('race-invest-partial');
    await creditDeposit(userId, '1000.00', 'race-invest-partial-dep');
    expect((await getAccountSnapshot(userId)).withdrawableBalance.toFixed(2)).toBe('1000.00');

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () => createInvestment({ user: session, planId, amountUsd: 250, ip: null })),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // 1000.00 / 250.00 = 4 exactly.
    expect(fulfilled.length).toBe(4);
    expect(rejected.length).toBe(BURST - 4);
    expect(rejected.every((r) => (r.reason as { code?: string } | undefined)?.code === 'INSUFFICIENT_FUNDS')).toBe(
      true,
    );

    const deployed = await prisma.investment.aggregate({
      where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } },
      _sum: { capitalUsd: true },
    });
    expect(D(deployed._sum.capitalUsd).toFixed(2)).toBe('1000.00');

    const snapshot = await getAccountSnapshot(userId);
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
  });
});
