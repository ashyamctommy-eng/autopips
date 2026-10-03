import './helpers/test-env';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { D, type Numeric } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { serverEnv } from '@/lib/env';
import { rkey } from '@/lib/redis';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { createInvestment } from '@/server/modules/account/account.service';
import {
  decideWithdrawal,
  handleIpn,
  requestWithdrawal,
} from '@/server/modules/payments/payments.service';
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
  fixtureEmail,
  fixtureMetaApiAccountId,
  isDatabaseReachable,
  purgeFixtures,
  trackBrokerConnection,
  trackRedisKey,
} from './helpers/fixtures';

/**
 * END-TO-END MONEY PATH — deposit → invest → trade → withdraw → paid, driven
 * through the REAL service functions against the REAL PostgreSQL ledger.
 *
 * This file is deliberately the "whole story" test: it does not seed the ledger
 * with hand-written equity inputs. It moves money the way production moves it,
 * re-reads the account after every step, and asserts three things every time:
 *
 *   1. the exact cent value the step must produce;
 *   2. the equity identity `equity === credited − paid + realizedPnL
 *      + unrealizedPnL − fees`, where EVERY term is re-aggregated by this test
 *      from raw rows (never taken from the ledger's own breakdown);
 *   3. that the change from the previous step equals the money that moved.
 *
 * The IPN signature is produced by an INDEPENDENT HMAC-SHA512 implementation
 * written below (its own canonicaliser, `node:crypto`) — it does not call
 * `canonicalizeForSignature` — so the deposit only lands if the module's own
 * canonicalisation agrees with a second, separately-written implementation.
 *
 * If Postgres is unreachable the whole file skips loudly (never silently).
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[money-path-e2e] SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const describeDb = databaseReachable ? describe : describe.skip;
const itDb = databaseReachable ? it : it.skip;

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

/* -------------------------------------------------------------------------- */
/* Independent ledger re-aggregation (the test's own arithmetic)              */
/* -------------------------------------------------------------------------- */

interface PersistedTerms {
  credited: Decimal;
  paid: Decimal;
  deployed: Decimal;
  idle: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  fees: Decimal;
  /** credited − paid + realizedPnL + unrealizedPnL − fees */
  equity: Decimal;
}

function soma(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

/**
 * Re-derive every equity term from RAW rows with `findMany` + Decimal sums —
 * a different query shape from `ledger.ts` (which uses `aggregate`), so the two
 * sides of each assertion are independently sourced.
 */
async function persistedTerms(userId: string): Promise<PersistedTerms> {
  const [deposits, withdrawals, investments, trades] = await Promise.all([
    prisma.deposit.findMany({ where: { userId }, select: { amountUsd: true, status: true } }),
    prisma.withdrawal.findMany({ where: { userId }, select: { amountUsd: true, status: true } }),
    prisma.investment.findMany({
      where: { userId },
      select: { capitalUsd: true, status: true, unrealizedPnL: true, feesDeducted: true },
    }),
    prisma.tradeRecord.findMany({
      where: { investment: { userId } },
      select: { netPnL: true, status: true },
    }),
  ]);

  const credited = soma(
    deposits.filter((d) => d.status === 'CONFIRMED' || d.status === 'FINISHED').map((d) => d.amountUsd),
  );
  const paid = soma(withdrawals.filter((w) => w.status === 'FINISHED').map((w) => w.amountUsd));
  const deployed = soma(
    investments.filter((i) => i.status === 'ACTIVE' || i.status === 'PAUSED').map((i) => i.capitalUsd),
  );
  const idle = credited.minus(deployed);
  const realizedPnL = soma(trades.filter((t) => t.status === 'CLOSED').map((t) => t.netPnL));
  const unrealizedPnL = soma(investments.map((i) => i.unrealizedPnL));
  const fees = soma(investments.map((i) => i.feesDeducted));

  return {
    credited,
    paid,
    deployed,
    idle,
    realizedPnL,
    unrealizedPnL,
    fees,
    equity: credited.minus(paid).plus(realizedPnL).plus(unrealizedPnL).minus(fees),
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario                                                                    */
/* -------------------------------------------------------------------------- */

let client!: SessionUser;
let adminId = '';
let planId = '';
let brokerId = '';
let depositId = '';
let depositPaymentId = '';
let investmentId = '';
let withdrawalId = '';

/** Snapshot of the step we are asserting against, captured as we go. */
let lastEquity = '';

function sessionOf(user: User): SessionUser {
  return toSessionUser(user);
}

/**
 * The invariant every step must satisfy, in both directions:
 *   * the ledger's own equity == the test's independent re-aggregation;
 *   * the ledger's component fields are internally consistent with equity.
 */
async function assertLedgerAtStep(label: string) {
  const terms = await persistedTerms(client.id);
  const snapshot = await getAccountSnapshot(client.id);

  // (1) the ledger equals THIS TEST's arithmetic, cent for cent
  expect(snapshot.breakdown.equity.toFixed(2), `${label}: equity == credited − paid + P/L − fees`).toBe(
    terms.equity.toFixed(2),
  );
  // (2) the components the ledger reports are the ones it summed
  expect(snapshot.breakdown.realizedPnL.toFixed(2), `${label}: realizedPnL`).toBe(
    terms.realizedPnL.toFixed(2),
  );
  expect(snapshot.breakdown.unrealizedPnL.toFixed(2), `${label}: unrealizedPnL`).toBe(
    terms.unrealizedPnL.toFixed(2),
  );
  expect(snapshot.breakdown.deductedFees.toFixed(2), `${label}: deductedFees`).toBe(terms.fees.toFixed(2));
  expect(snapshot.breakdown.withdrawals.toFixed(2), `${label}: withdrawals`).toBe(terms.paid.toFixed(2));
  expect(snapshot.breakdown.startingCapital.toFixed(2), `${label}: startingCapital`).toBe(
    terms.deployed.toFixed(2),
  );
  expect(snapshot.breakdown.confirmedDeposits.toFixed(2), `${label}: confirmedDeposits (idle)`).toBe(
    terms.idle.toFixed(2),
  );
  expect(snapshot.totalCreditedDeposits.toFixed(2), `${label}: credited`).toBe(terms.credited.toFixed(2));
  expect(snapshot.netContributedCapital.toFixed(2), `${label}: netContributed`).toBe(
    terms.credited.minus(terms.paid).toFixed(2),
  );

  // (3) the manage-account identity, written out in full
  const identity = snapshot.netContributedCapital
    .plus(snapshot.breakdown.realizedPnL)
    .plus(snapshot.breakdown.unrealizedPnL)
    .minus(snapshot.breakdown.deductedFees);
  expect(snapshot.breakdown.equity.toFixed(2), `${label}: equity identity`).toBe(identity.toFixed(2));

  // (4) withdrawableBalance is equity − deployed − pending, never negative
  const pending = soma(
    (
      await prisma.withdrawal.findMany({
        where: { userId: client.id, status: { in: ['PENDING', 'WAITING', 'CONFIRMED', 'SENDING'] } },
        select: { amountUsd: true },
      })
    ).map((w) => w.amountUsd),
  );
  expect(snapshot.pendingWithdrawals.toFixed(2), `${label}: pendingWithdrawals`).toBe(pending.toFixed(2));
  const expectedWithdrawable = snapshot.breakdown.equity.minus(terms.deployed).minus(pending);
  expect(snapshot.withdrawableBalance.toFixed(2), `${label}: withdrawableBalance`).toBe(
    (expectedWithdrawable.lessThan(0) ? new Decimal(0) : expectedWithdrawable).toFixed(2),
  );

  return snapshot;
}

function equityDelta(from: string, to: string): string {
  return D(to).minus(D(from)).toFixed(2);
}

describeDb('money path e2e: deposit → invest → trade → withdraw → paid (real services, real DB)', () => {
  beforeAll(async () => {
    await purgeFixtures();

    // (a) REGISTER A CLIENT — a real Argon2id password hash, then the real
    //     session mapper (`toSessionUser`) so the SessionUser handed to the
    //     services is exactly what a route would hand them.
    const userRow = await createFixtureUser('money-path');
    client = sessionOf(userRow);
    expect(client.kycStatus).toBe('APPROVED');
    expect(client.role).toBe('CLIENT');

    // ...and FIND it again the way a request would (read back by id).
    const found = await prisma.user.findUnique({ where: { id: client.id } });
    expect(found?.email).toBe(client.email);

    const admin = await prisma.user.create({
      data: {
        email: fixtureEmail('money-path-admin'),
        passwordHash: found?.passwordHash ?? 'fixture-not-a-real-argon2-hash',
        fullName: 'Verify Suite Money-Path Admin',
        country: 'KE',
        role: 'ADMIN',
        kycStatus: 'APPROVED',
      },
    });
    adminId = admin.id;

    planId = (await createFixturePlan('money-path')).id;

    const broker = await prisma.brokerConnection.create({
      data: {
        derivAccountId: fixtureMetaApiAccountId('money-path'),
        brokerName: 'Fixture Broker',
        environment: 'DEMO',
        maskedAccount: '***-0001',
        balance: '0.00',
        equity: '0.00',
        freeMargin: '0.00',
        status: 'CONNECTED',
      },
    });
    brokerId = broker.id;
    trackBrokerConnection(broker.id);
  });

  afterAll(async () => {
    if (!databaseReachable) return;
    const report = await purgeFixtures();
    console.log(`[money-path-e2e] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    const residue = await countFixtureResidue();
    console.log(`[money-path-e2e] residue after cleanup (must be all zeros):`, residue);
    await assertNoFixtureRowsLeft();
  });

  itDb('(a) the new client has a zero ledger — no invented balance', async () => {
    const snapshot = await assertLedgerAtStep('a: fresh client');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    expect(snapshot.openInvestments).toBe(0);
    lastEquity = '0.00';
  });

  itDb('(b) a verified IPN credits the deposit: equity +1000.00, idle 1000.00, startingCapital 0.00', async () => {
    const DEPOSIT = '1000.00';

    // The provider round-trip in `createDeposit` cannot run offline; the row it
    // would persist (PENDING + paymentId + address) is created here, and the
    // CREDITING then goes exclusively through the real IPN handler.
    const deposit = await createPendingDeposit(client.id, DEPOSIT, 'money-path-dep');
    depositId = deposit.id;
    depositPaymentId = deposit.paymentId;

    // Deliberately NOT in alphabetical order: the canonicaliser must sort.
    const ipnBody = {
      payment_status: 'finished',
      pay_currency: 'usdttrc20',
      payment_id: deposit.paymentId,
      price_amount: 1000,
      price_currency: 'usd',
      pay_amount: 1000,
      actually_paid: 1000,
      outcome_amount: 1000,
      outcome_currency: 'usdttrc20',
      pay_address: deposit.depositAddress,
      order_id: deposit.id,
    };
    const rawBody = JSON.stringify(ipnBody);
    const signature = independentIpnSignature(ipnBody);

    const result = await handleIpn({ rawBody, signature, ip: '203.0.113.9' });
    expect(result.matched).toBe(true);
    expect(result.credited).toBe(true);
    expect(result.status).toBe('FINISHED');

    const row = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(['CONFIRMED', 'FINISHED']).toContain(row.status);
    expect(D(row.amountUsd).toFixed(2)).toBe(DEPOSIT);

    // The replay guard's Redis slot is fixture-owned: track it for cleanup.
    trackRedisKey(rkey('once', `ipn:${deposit.paymentId}:finished`));

    const snapshot = await assertLedgerAtStep('b: deposit credited');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('1000.00');
    expect(equityDelta(lastEquity, snapshot.breakdown.equity.toFixed(2))).toBe(DEPOSIT);
    lastEquity = snapshot.breakdown.equity.toFixed(2);
  });

  itDb('(c) investing the full amount is equity-NEUTRAL: 1000.00 still, idle 0.00, withdrawable 0.00', async () => {
    const invested = await createInvestment({
      user: client,
      planId,
      amountUsd: 1000,
      ip: null,
    });
    investmentId = invested.id;
    expect(invested.status).toBe('ACTIVE');
    expect(invested.capitalUsd).toBe(1000);

    const snapshot = await assertLedgerAtStep('c: capital deployed');
    // The money MOVED BUCKETS; the total did not move by a cent.
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(equityDelta(lastEquity, snapshot.breakdown.equity.toFixed(2))).toBe('0.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('1000.00'); // == the deposit
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(snapshot.activeCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.openInvestments).toBe(1);
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    lastEquity = snapshot.breakdown.equity.toFixed(2);
  });

  itDb('(d) the air-withdrawal hole is closed: any positive withdrawal throws INSUFFICIENT_FUNDS', async () => {
    await expect(
      requestWithdrawal({
        user: client,
        amountUsd: 0.01,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    // Even a token request left nothing behind.
    expect(await prisma.withdrawal.count({ where: { userId: client.id } })).toBe(0);

    // ...and re-investing the already-deployed dollar is equally impossible.
    await expect(
      createInvestment({ user: client, planId, amountUsd: 100, ip: null }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    const snapshot = await assertLedgerAtStep('d: rejected withdrawal');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
  });

  itDb('(e) a broker-written CLOSED trade of +250.00 raises equity to 1250.00 and frees 250.00', async () => {
    // Written exactly the way the broker sync writes a closed deal: a CLOSED
    // TradeRecord on the funded investment, with the broker's net result.
    const trade = await prisma.tradeRecord.create({
      data: {
        investmentId,
        brokerId,
        derivContractId: `${FIXTURE_TAG}-money-path-pos-1`,
        instrument: 'XAUUSD',
        direction: 'BUY',
        volume: '0.10',
        entryPrice: '2400.00000',
        exitPrice: '2402.50000',
        grossPnL: '250.00',
        commission: '0.00',
        swap: '0.00',
        netPnL: '250.00',
        status: 'CLOSED',
        closedAt: new Date('2026-09-22T10:00:00.000Z'),
      },
    });
    expect(trade.status).toBe('CLOSED');

    const snapshot = await assertLedgerAtStep('e: profit booked');
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe('250.00');
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1250.00');
    expect(equityDelta(lastEquity, snapshot.breakdown.equity.toFixed(2))).toBe('250.00');
    // Profits are the ONLY thing that frees capital: equity 1250 − deployed 1000.
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('250.00');
    lastEquity = snapshot.breakdown.equity.toFixed(2);
  });

  itDb('(f) withdrawing exactly 250.00 succeeds and only RESERVES it (equity unchanged)', async () => {
    const withdrawal = await requestWithdrawal({
      user: client,
      amountUsd: 250,
      cryptoCurrency: 'usdttrc20',
      payoutAddress: TRON_PAYOUT_ADDRESS,
      ip: null,
    });
    withdrawalId = withdrawal.id;
    expect(withdrawal.status).toBe('PENDING');
    expect(withdrawal.amountUsd).toBe(250);

    const snapshot = await assertLedgerAtStep('f: withdrawal requested');
    // A PENDING withdrawal is not paid: equity is untouched, but the money is
    // reserved so it cannot be requested or invested twice.
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1250.00');
    expect(equityDelta(lastEquity, snapshot.breakdown.equity.toFixed(2))).toBe('0.00');
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe('0.00');
    expect(snapshot.pendingWithdrawals.toFixed(2)).toBe('250.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');

    // A second attempt for the same money is refused while it is in flight.
    await expect(
      requestWithdrawal({
        user: client,
        amountUsd: 250,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    lastEquity = snapshot.breakdown.equity.toFixed(2);
  });

  itDb('(g) the admin approval settles it: equity falls 250.00 back to 1000.00, withdrawable 0.00', async () => {
    const settled = await decideWithdrawal({
      id: withdrawalId,
      adminUserId: adminId,
      decision: 'APPROVE',
      // Operator-recorded chain proof — this is the branch that marks FINISHED
      // without any payout-network call.
      txHash: `${FIXTURE_TAG}-money-path-tx`,
      ip: null,
    });
    expect(settled.status).toBe('FINISHED');
    expect(settled.txHash).toBe(`${FIXTURE_TAG}-money-path-tx`);

    const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    expect(row.status).toBe('FINISHED');
    expect(row.approvedBy).toBe(adminId);

    const snapshot = await assertLedgerAtStep('g: payout settled');
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe('250.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(equityDelta(lastEquity, snapshot.breakdown.equity.toFixed(2))).toBe('-250.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('1000.00'); // deployed capital untouched
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(snapshot.pendingWithdrawals.toFixed(2)).toBe('0.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    lastEquity = snapshot.breakdown.equity.toFixed(2);
  });

  itDb('(h) the whole path nets out: credited 1000.00, paid 250.00, P/L +250.00 ⇒ equity 1000.00', async () => {
    // Gross-in − gross-out + where the money went = what is left. Independent of
    // every intermediate snapshot above.
    const terms = await persistedTerms(client.id);
    expect(terms.credited.toFixed(2)).toBe('1000.00');
    expect(terms.paid.toFixed(2)).toBe('250.00');
    expect(terms.realizedPnL.toFixed(2)).toBe('250.00');
    expect(terms.unrealizedPnL.toFixed(2)).toBe('0.00');
    expect(terms.fees.toFixed(2)).toBe('0.00');
    expect(terms.deployed.toFixed(2)).toBe('1000.00');
    expect(terms.idle.toFixed(2)).toBe('0.00');
    expect(terms.equity.toFixed(2)).toBe('1000.00');

    const snapshot = await assertLedgerAtStep('h: final');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(lastEquity);

    // Every row this scenario created still belongs to the fixture tag, so the
    // afterAll purge has something to prove.
    const owned = await prisma.user.count({ where: { id: client.id, email: { startsWith: FIXTURE_TAG } } });
    expect(owned).toBe(1);
  });
});
