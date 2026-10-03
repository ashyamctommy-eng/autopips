import './helpers/test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { assertEquityConsistency, computeEquity, type EquityInputs } from '@/server/accounting/equity';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { createInvestment } from '@/server/modules/account/account.service';
import { requestWithdrawal } from '@/server/modules/payments/payments.service';
import type { SessionUser } from '@/types/api';
import {
  FIXTURE_TAG,
  assertNoFixtureRowsLeft,
  countFixtureResidue,
  fixtureEmail,
  fixtureMetaApiAccountId,
  fixturePaymentId,
  isDatabaseReachable,
  purgeFixtures,
  trackBrokerConnection,
} from './helpers/fixtures';

/**
 * LIVE LEDGER INTEGRATION SUITE.
 *
 * Runs against the REAL PostgreSQL instance (Prisma client, no mocks, no fake
 * repository): rows are written, `getAccountSnapshot()` is asked for the equity,
 * and the number it returns is compared against the formula with exact cent
 * strings.
 *
 * THE MODEL THIS SUITE PROTECTS (read before changing a single number)
 * ────────────────────────────────────────────────────────────────────────────
 * `startingCapital` and `confirmedDeposits` are a PARTITION of GROSS credited
 * capital, not two independent sums and not both net of withdrawals:
 *
 *   deployedCapital   = Σ Investment.capitalUsd  (ACTIVE + PAUSED only)
 *   credited          = Σ Deposit.amountUsd      (CONFIRMED + FINISHED only)
 *   paidWithdrawals   = Σ Withdrawal.amountUsd   (FINISHED only)
 *   startingCapital   = deployedCapital                     ← the DEPLOYED half
 *   confirmedDeposits = max(0, credited − deployedCapital)   ← the IDLE half
 *   netContributed    = credited − paidWithdrawals
 *
 * `computeEquity` then subtracts `paidWithdrawals` exactly ONCE:
 *
 *   equity = (deployed) + (credited − deployed) + P/L − fees − paid
 *          = credited − paid + P/L − fees
 *          = netContributed + Realized P/L + Unrealized P/L − Deducted Fees
 *
 * Two equivalently-shaped identities must hold for every account:
 *
 *   (I)  netContributedCapital === startingCapital + confirmedDeposits − withdrawals
 *   (II) equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees
 *
 * (I) only holds while the defensive `max(0, …)` clamp on idle cash is inactive,
 * i.e. while credited ≥ deployed. That is the case for every fixture below and
 * for any well-formed ledger (capital cannot be deployed without being funded).
 *
 * Two WRONG models are permanently banned, and the regression block at the
 * bottom of this file pins them:
 *
 *   (a) DOUBLE-COUNT: summing ALL investment capital *and* ALL credited deposits
 *       (deposit $1,000 → invest it → equity reads $2,000 of thin air); and
 *   (b) DOUBLE-DEBIT: building the idle term from already-net capital
 *       (`netContributed − deployed`) and then letting `computeEquity` subtract
 *       withdrawals again (every FINISHED withdrawal debited twice).
 *
 * Both defects were live in src/ until 2026-09-23; `ledger.ts` now has ONE pure
 * assembler (`buildEquityFromAggregates`) that every surface calls. This suite
 * is the ratchet that keeps both of them from returning.
 *
 * What else this suite protects:
 *   * only CONFIRMED/FINISHED deposits credit; only FINISHED withdrawals debit;
 *   * realizedPnL comes from CLOSED TradeRecord.netPnL (never a stored column);
 *   * an OPEN trade is never read as realized P/L;
 *   * every fixture row is deleted afterwards (asserted, not assumed).
 *
 * If Postgres is unreachable the whole file is skipped with a loud console
 * message so `npm test` still passes in a database-less CI.
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[integration-ledger] SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const describeDb = databaseReachable ? describe : describe.skip;
const itDb = databaseReachable ? it : it.skip;

/**
 * Hand-computed expectation table for the coherent base fixture.
 *
 * FIXTURE HISTORY (why these numbers are physically reachable)
 * ────────────────────────────────────────────────────────────
 *   1. client deposits 12,000.00 in total   (CONFIRMED 11,500.00 + FINISHED 500.00)
 *   2. invests 11,300.00 in total           (ACTIVE 10,000 + PAUSED 1,000 + 300 closed later)
 *   3. the 300.00 investment is CLOSED      → its capital returns to idle cash
 *   4. client withdraws 1,000.00 (FINISHED) from the idle cash
 * => deployed 11,000.00, gross credited 12,000.00, so idle 1,000.00. The account
 *    was funded before it was deployed (credited 12,000.00 > deployed 11,000.00)
 *    and the withdrawal was covered by idle cash, so
 *    `createInvestment`/`requestWithdrawal` would have allowed every step.
 *
 * ARITHMETIC (all cent-exact; every number below is recomputed from the rows)
 * ────────────────────────────────────────────────────────────────────────────
 *   deployedCapital   = 10000.00 (ACTIVE) + 1000.00 (PAUSED)           = 11000.00
 *                       (the CLOSED 300.00 is NOT deployed)
 *   credited          = 11500.00 (CONFIRMED) + 500.00 (FINISHED)       = 12000.00
 *                       (PENDING 9999.99 / FAILED 8888.88 / WAITING 777.77 /
 *                        REFUNDED 55.55 never credit)
 *   paidWithdrawals   = 1000.00 (FINISHED)                              =  1000.00
 *                       (PENDING 250.00 / SENDING 100.00 / FAILED 777.00 never debit)
 *   startingCapital   = deployedCapital                                = 11000.00
 *   confirmedDeposits = max(0, 12000.00 − 11000.00)                    =  1000.00
 *   netContributed    = credited − paid = 12000.00 − 1000.00           = 11000.00
 *   realizedPnL       = +250.00 − 120.45   (CLOSED trades only)        =   129.55
 *   unrealizedPnL     = 120.55  (ACTIVE column; PAUSED/CLOSED are 0.00) =   120.55
 *   deductedFees      = 75.25   (ACTIVE column)                        =    75.25
 *   equity            = 11000.00 + 1000.00 + 129.55 + 120.55 − 75.25 − 1000.00
 *                     = 11174.85   ← what the ledger reports
 *   equity (identity) = netContributed + realized + unrealized − fees
 *                     = 11000.00 + 129.55 + 120.55 − 75.25            = 11174.85  ✓
 *   ── the two agree to the cent. Both WRONG models are ruled out by the same
 *      number: the double-count model would report 23000.00 + P/L − fees
 *      (11000.00 deployed read as capital on top of 12000.00 credited), and the
 *      double-debit model would report 10174.85 (exactly 1000.00 short, the
 *      FINISHED withdrawal subtracted a second time).
 *   activeCapital     = 11000.00 (ACTIVE + PAUSED both stay locked)
 *   pendingWithdrawals= 250.00 + 100.00                                =   350.00
 *   withdrawable      = max(0, 11174.85 − 11000.00 − 350.00) = max(0, −175.15)
 *                     = 0.00  (an account whose equity is below its deployed
 *                              capital has nothing free to withdraw)
 *   openInvestments   = 2 (ACTIVE + PAUSED)
 */
const EXPECTED = {
  startingCapital: '11000.00', // Σ capitalUsd WHERE status ∈ {ACTIVE, PAUSED}
  confirmedDeposits: '1000.00', // idle cash = max(0, credited 12000.00 − deployed 11000.00)
  netContributedCapital: '11000.00', // credited 12000.00 − paid 1000.00
  realizedPnL: '129.55', // +250.00 − 120.45 (CLOSED only)
  unrealizedPnL: '120.55', // broker-written Investment.unrealizedPnL
  deductedFees: '75.25',
  withdrawals: '1000.00', // FINISHED only
  equity: '11174.85', // 11000.00 + 1000.00 + 129.55 + 120.55 − 75.25 − 1000.00
  activeCapital: '11000.00',
  pendingWithdrawals: '350.00', // PENDING 250.00 + SENDING 100.00
  withdrawableBalance: '0.00', // max(0, 11174.85 − 11000.00 − 350.00) = max(0, −175.15)
  openInvestments: 2,
} as const;

/** A syntactically valid TRC20 payout address (34 chars, base58check shape). */
const TRON_PAYOUT_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

interface Fixture {
  userId: string;
  planId: string;
  brokerId: string;
  activeInvestmentId: string;
  pausedInvestmentId: string;
  closedInvestmentId: string;
  pendingDepositId: string;
  failedDepositId: string;
  waitingDepositId: string;
  refundedDepositId: string;
  pendingWithdrawalId: string;
}

let fixture!: Fixture;

/** A real SessionUser shape, exactly what a route would hand to a service. */
function sessionOf(user: {
  id: string;
  email: string;
  fullName: string;
  country: string;
  kycStatus: string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: 'CLIENT',
    kycStatus: user.kycStatus as SessionUser['kycStatus'],
    is2FAEnabled: false,
    country: user.country,
    createdAt: new Date().toISOString(),
  };
}

/** Scenario user: prefix-tagged, KYC-approved, cleaned up by `purgeFixtures()`. */
async function createScenarioUser(label: string) {
  return prisma.user.create({
    data: {
      email: fixtureEmail(label),
      passwordHash: 'fixture-not-a-real-argon2-hash',
      fullName: `Verify Suite ${label}`,
      country: 'KE',
      role: 'CLIENT',
      kycStatus: 'APPROVED',
    },
  });
}

/** Active plan — required by the real `createInvestment()` service. */
async function createActivePlan(label: string) {
  return prisma.tradingPlan.create({
    data: {
      name: `${FIXTURE_TAG} ${label} plan`,
      description: 'verification-suite scenario plan',
      minInvestment: '100.00',
      maxInvestment: '1000000.00',
      durationDays: 90,
      targetReturnMin: '5.00',
      targetReturnMax: '12.00',
      riskLevel: 'MEDIUM',
      performanceFee: '20.00',
      managementFee: '1.50',
      maxDrawdown: '15.00',
      isActive: true,
    },
  });
}

async function creditDeposit(
  userId: string,
  amountUsd: string,
  label: string,
  status: 'CONFIRMED' | 'FINISHED' = 'CONFIRMED',
) {
  return prisma.deposit.create({
    data: {
      userId,
      amountUsd,
      cryptoCurrency: 'usdttrc20',
      paymentId: fixturePaymentId(label),
      depositAddress: 'TFixtureAddress',
      payAmount: amountUsd,
      status,
    },
  });
}

describeDb('ledger integration: account snapshot from real ledger rows', () => {
  beforeAll(async () => {
    // Defence in depth: remove anything a previously crashed run left behind
    // (only rows carrying this suite's prefix are ever touched).
    await purgeFixtures();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('ledger'),
        passwordHash: 'fixture-not-a-real-argon2-hash',
        fullName: 'Verify Suite Ledger Fixture',
        country: 'KE',
        role: 'CLIENT',
        kycStatus: 'APPROVED',
      },
    });

    const plan = await prisma.tradingPlan.create({
      data: {
        name: `${FIXTURE_TAG} ledger plan`,
        description: 'verification-suite fixture plan',
        minInvestment: '100.00',
        maxInvestment: '1000000.00',
        durationDays: 90,
        targetReturnMin: '5.00',
        targetReturnMax: '12.00',
        riskLevel: 'MEDIUM',
        performanceFee: '20.00',
        managementFee: '1.50',
        maxDrawdown: '15.00',
        isActive: false,
      },
    });

    const broker = await prisma.brokerConnection.create({
      data: {
        derivAccountId: fixtureMetaApiAccountId('ledger'),
        brokerName: 'Fixture Broker',
        environment: 'DEMO',
        maskedAccount: '***-0000',
        balance: '0.00',
        equity: '0.00',
        freeMargin: '0.00',
        status: 'CONNECTED',
      },
    });
    trackBrokerConnection(broker.id);

    // ── DEPLOYED: 10000.00 ACTIVE + 1000.00 PAUSED = 11000.00 ──────────────
    const active = await prisma.investment.create({
      data: {
        userId: user.id,
        planId: plan.id,
        capitalUsd: '10000.00',
        // Informational only — the ledger never reads currentValUsd (it is
        // derived from capital + P/L - fees by the broker sync worker).
        currentValUsd: '10045.30',
        realizedPnL: '129.55',
        unrealizedPnL: '120.55',
        feesDeducted: '75.25',
        status: 'ACTIVE',
      },
    });

    const paused = await prisma.investment.create({
      data: {
        userId: user.id,
        planId: plan.id,
        capitalUsd: '1000.00',
        currentValUsd: '1000.00',
        realizedPnL: '0.00',
        unrealizedPnL: '0.00',
        feesDeducted: '0.00',
        status: 'PAUSED',
      },
    });

    // CLOSED capital is NOT deployed: it is idle cash again. It therefore shows
    // up in netContributedCapital but never in startingCapital/activeCapital.
    const closed = await prisma.investment.create({
      data: {
        userId: user.id,
        planId: plan.id,
        capitalUsd: '300.00',
        currentValUsd: '300.00',
        realizedPnL: '0.00',
        unrealizedPnL: '0.00',
        feesDeducted: '0.00',
        status: 'CLOSED',
      },
    });

    // Trades: two CLOSED (the only rows that may become realized P/L) and one OPEN.
    await prisma.tradeRecord.create({
      data: {
        investmentId: active.id,
        brokerId: broker.id,
        derivContractId: `${FIXTURE_TAG}-pos-1`,
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
        closedAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    });

    await prisma.tradeRecord.create({
      data: {
        investmentId: active.id,
        brokerId: broker.id,
        derivContractId: `${FIXTURE_TAG}-pos-2`,
        instrument: 'XAUUSD',
        direction: 'SELL',
        volume: '0.05',
        entryPrice: '2410.00000',
        exitPrice: '2412.40900',
        grossPnL: '-120.45',
        commission: '0.00',
        swap: '0.00',
        netPnL: '-120.45',
        status: 'CLOSED',
        closedAt: new Date('2026-08-02T10:00:00.000Z'),
      },
    });

    // The OPEN trade carries a netPnL that must NEVER be read as realized:
    // an open position has no realized profit.
    await prisma.tradeRecord.create({
      data: {
        investmentId: active.id,
        brokerId: broker.id,
        derivContractId: `${FIXTURE_TAG}-pos-3`,
        instrument: 'XAUUSD',
        direction: 'BUY',
        volume: '0.20',
        entryPrice: '2420.00000',
        grossPnL: '555.00',
        commission: '0.00',
        swap: '0.00',
        netPnL: '555.00',
        status: 'OPEN',
      },
    });

    // Deposits: only the first two may be credited. 11500.00 + 500.00 = 12000.00.
    await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '11500.00',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-confirmed'),
        depositAddress: 'TFixtureAddressConfirmed',
        payAmount: '11500.00000000',
        status: 'CONFIRMED',
      },
    });
    await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '500.00',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-finished'),
        depositAddress: 'TFixtureAddressFinished',
        payAmount: '500.00000000',
        status: 'FINISHED',
      },
    });
    const pending = await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '9999.99',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-pending'),
        depositAddress: 'TFixtureAddressPending',
        payAmount: '9999.99000000',
        status: 'PENDING',
      },
    });
    const failed = await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '8888.88',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-failed'),
        depositAddress: 'TFixtureAddressFailed',
        payAmount: '8888.88000000',
        status: 'FAILED',
      },
    });
    const waiting = await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '777.77',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-waiting'),
        depositAddress: 'TFixtureAddressWaiting',
        payAmount: '777.77000000',
        status: 'WAITING',
      },
    });
    const refunded = await prisma.deposit.create({
      data: {
        userId: user.id,
        amountUsd: '55.55',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-refunded'),
        depositAddress: 'TFixtureAddressRefunded',
        payAmount: '55.55000000',
        status: 'REFUNDED',
      },
    });

    // Withdrawals: only the FINISHED row may be debited. 1000.00 leaves the
    // account; that is exactly the idle cash released by the closed investment
    // in the fixture history above (700.00 spare + 300.00 returned).
    await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '1000.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutFinished',
        status: 'FINISHED',
        txHash: `${FIXTURE_TAG}-tx-1`,
      },
    });
    const pendingWithdrawal = await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '250.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutPending',
        status: 'PENDING',
      },
    });
    await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '100.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutSending',
        status: 'SENDING',
      },
    });
    await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '777.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutFailed',
        status: 'FAILED',
      },
    });

    fixture = {
      userId: user.id,
      planId: plan.id,
      brokerId: broker.id,
      activeInvestmentId: active.id,
      pausedInvestmentId: paused.id,
      closedInvestmentId: closed.id,
      pendingDepositId: pending.id,
      failedDepositId: failed.id,
      waitingDepositId: waiting.id,
      refundedDepositId: refunded.id,
      pendingWithdrawalId: pendingWithdrawal.id,
    };
  });

  afterAll(async () => {
    if (!databaseReachable) return;
    const report = await purgeFixtures();
    console.log(`[integration-ledger] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    // TASK 3: leave ZERO rows behind, and PRINT the residue counts so a silent
    // leak is impossible to miss in CI logs.
    const residue = await countFixtureResidue();
    console.log(`[integration-ledger] residue after cleanup (must be all zeros):`, residue);
    await assertNoFixtureRowsLeft();
  });

  it('returns the equity the straight-line formula predicts, cent for cent', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe(EXPECTED.startingCapital);
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe(EXPECTED.realizedPnL);
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe(EXPECTED.unrealizedPnL);
    expect(snapshot.breakdown.deductedFees.toFixed(2)).toBe(EXPECTED.deductedFees);
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe(EXPECTED.withdrawals);
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe(EXPECTED.confirmedDeposits);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
    expect(snapshot.activeCapital.toFixed(2)).toBe(EXPECTED.activeCapital);
    expect(snapshot.pendingWithdrawals.toFixed(2)).toBe(EXPECTED.pendingWithdrawals);
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe(EXPECTED.withdrawableBalance);
    expect(snapshot.openInvestments).toBe(EXPECTED.openInvestments);
    expect(snapshot.netContributedCapital.toFixed(2)).toBe(EXPECTED.netContributedCapital);
  });

  it('the persisted rows satisfy the formula independently (recomputation from the same inputs)', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);
    const inputs: EquityInputs = {
      startingCapital: EXPECTED.startingCapital,
      realizedPnL: EXPECTED.realizedPnL,
      unrealizedPnL: EXPECTED.unrealizedPnL,
      deductedFees: EXPECTED.deductedFees,
      withdrawals: EXPECTED.withdrawals,
      confirmedDeposits: EXPECTED.confirmedDeposits,
    };
    const recomputed = computeEquity(inputs);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(recomputed.equity.toFixed(2));

    // And the same inputs must also satisfy assertEquityConsistency against the
    // stored snapshot (a 1-cent drift is reported as an integrity violation).
    expect(() => assertEquityConsistency(inputs, snapshot.breakdown.equity)).not.toThrow();
    expect(() => assertEquityConsistency(inputs, snapshot.breakdown.equity.toFixed(2))).not.toThrow();
    // One cent off — proves the boundary is a violation, not a tolerance.
    expect(() =>
      assertEquityConsistency(inputs, D(snapshot.breakdown.equity).plus('0.01')),
    ).toThrowError(/Accounting integrity violation/);
  });

  /**
   * THE HEADLINE INVARIANT of the corrected model, asserted explicitly.
   *
   *   (1) startingCapital + confirmedDeposits === netContributedCapital
   *   (2) equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees
   *
   * NOTE ON SCOPE: identity (2) only holds while `unallocatedCash` is not
   * clamped, i.e. while the client has NO idle cash. This fixture is built so
   * that netContributedCapital (11000.00) === deployedCapital (11000.00), i.e.
   * idle === 0.00. That is a real, reachable account state (withdrawal funded
   * out of idle cash). When idle cash exists, the current ledger drops identity
   * (2) by exactly the finished withdrawals — pinned as KNOWN SRC DEFECT D1 in
   * the regression block below.
   */
  it('the two capital terms partition GROSS contributed capital (headline invariant #1)', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);
    const deployedPlusIdle = snapshot.breakdown.startingCapital.plus(snapshot.breakdown.confirmedDeposits);

    // (1) partition: deployed + idle === GROSS credited deposits
    //     11000.00 (deployed) + 1000.00 (idle) = 12000.00 (credited)
    expect(deployedPlusIdle.toFixed(2)).toBe('12000.00');
    expect(deployedPlusIdle.toFixed(2)).toBe(snapshot.totalCreditedDeposits.toFixed(2));

    // ...and subtracting the FINISHED withdrawals turns gross into net:
    //     12000.00 − 1000.00 = 11000.00 = netContributedCapital
    expect(deployedPlusIdle.minus(snapshot.breakdown.withdrawals).toFixed(2)).toBe(
      snapshot.netContributedCapital.toFixed(2),
    );
    expect(snapshot.netContributedCapital.toFixed(2)).toBe(EXPECTED.netContributedCapital);

    // The deployed half never exceeds the net contributed capital (the client
    // can never deploy money they have taken back out).
    expect(snapshot.breakdown.startingCapital.lessThanOrEqualTo(snapshot.netContributedCapital)).toBe(true);

    // The two terms do not overlap: the old double-count model would have summed
    // them to 11000.00 + 12000.00 = 23000.00 of "capital" on 12000.00 of deposits.
    expect(deployedPlusIdle.toFixed(2)).not.toBe('23000.00');
    // ...and the double-debit model would have made the partition net-of-
    // withdrawals (11000.00) instead of gross (12000.00).
    expect(deployedPlusIdle.toFixed(2)).not.toBe('11000.00');
  });

  /**
   * THE HEADLINE IDENTITY — was `it.fails` while SRC DEFECT D1 was live
   * (finished withdrawals subtracted twice once idle cash exists); promoted to a
   * normal, passing test on 2026-09-23 when `ledger.ts` was corrected. If this
   * ever fails again, D1 has returned.
   *
   *   (II) equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees
   */
  it('HEADLINE IDENTITY: equity === netContributedCapital + realizedPnL + unrealizedPnL − deductedFees', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);
    const identity = snapshot.netContributedCapital
      .plus(snapshot.breakdown.realizedPnL)
      .plus(snapshot.breakdown.unrealizedPnL)
      .minus(snapshot.breakdown.deductedFees);
    // 11000.00 + 129.55 + 120.55 − 75.25 = 11174.85
    expect(identity.toFixed(2)).toBe('11174.85');
    expect(identity.toFixed(2)).toBe(EXPECTED.equity);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(identity.toFixed(2));

    // And the second identity, from the capital partition:
    //   netContributed = deployed + idle − withdrawals
    //   (I) 11000.00 + 1000.00 − 1000.00 = 11000.00 ✓
    expect(
      snapshot.breakdown.startingCapital
        .plus(snapshot.breakdown.confirmedDeposits)
        .minus(snapshot.breakdown.withdrawals)
        .toFixed(2),
    ).toBe(snapshot.netContributedCapital.toFixed(2));
  });

  /**
   * The identity in its component form, computed from the persisted rows rather
   * than from the ledger's own breakdown — so the two sides of every equality
   * are independently sourced.
   */
  it('the equity identity holds when every term is re-read from the persisted rows', async () => {
    const [credited, paid, deployed, closed, portfolio] = await Promise.all([
      prisma.deposit.aggregate({
        where: { userId: fixture.userId, status: { in: ['CONFIRMED', 'FINISHED'] } },
        _sum: { amountUsd: true },
      }),
      prisma.withdrawal.aggregate({
        where: { userId: fixture.userId, status: 'FINISHED' },
        _sum: { amountUsd: true },
      }),
      prisma.investment.aggregate({
        where: { userId: fixture.userId, status: { in: ['ACTIVE', 'PAUSED'] } },
        _sum: { capitalUsd: true },
      }),
      prisma.tradeRecord.aggregate({
        where: { investment: { userId: fixture.userId }, status: 'CLOSED' },
        _sum: { netPnL: true },
      }),
      prisma.investment.aggregate({
        where: { userId: fixture.userId },
        _sum: { unrealizedPnL: true, feesDeducted: true },
      }),
    ]);

    // equity = credited − paid + realizedPnL + unrealizedPnL − fees
    //        = 12000.00 − 1000.00 + 129.55 + 120.55 − 75.25 = 11174.85
    const independent = D(credited._sum.amountUsd)
      .minus(D(paid._sum.amountUsd))
      .plus(D(closed._sum.netPnL))
      .plus(D(portfolio._sum.unrealizedPnL))
      .minus(D(portfolio._sum.feesDeducted));
    expect(independent.toFixed(2)).toBe('11174.85');

    // ...and it equals what the ledger reports, to the cent.
    const snapshot = await getAccountSnapshot(fixture.userId);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe(independent.toFixed(2));

    // The independent deployed figure is the same number the ledger calls
    // startingCapital, so the two sources genuinely cross-check.
    expect(D(deployed._sum.capitalUsd).toFixed(2)).toBe(snapshot.breakdown.startingCapital.toFixed(2));
  });

  it('realizedPnL equals the sum of CLOSED TradeRecord.netPnL only (+250.00 - 120.45)', async () => {
    const closedSum = await prisma.tradeRecord.aggregate({
      where: { investment: { userId: fixture.userId }, status: 'CLOSED' },
      _sum: { netPnL: true },
    });
    expect(D(closedSum._sum.netPnL).toFixed(2)).toBe(EXPECTED.realizedPnL);

    const snapshot = await getAccountSnapshot(fixture.userId);
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe('129.55');
  });

  it('an OPEN trade contributes to unrealizedPnL only, never to realizedPnL', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);
    // The OPEN row carries netPnL 555.00 — it must not appear in realized P/L...
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe('129.55');
    expect(snapshot.breakdown.realizedPnL.toFixed(2)).not.toBe('684.55');

    // ...while the broker-sourced unrealized figure is carried through exactly once.
    const openRows = await prisma.tradeRecord.findMany({
      where: { investment: { userId: fixture.userId }, status: 'OPEN' },
      select: { netPnL: true },
    });
    expect(openRows).toHaveLength(1);
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe('120.55');
    expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).not.toBe('675.55');
  });

  it('a PENDING or FAILED deposit does NOT increase equity; confirming it does', async () => {
    const before = await getAccountSnapshot(fixture.userId);

    const extraPending = await prisma.deposit.create({
      data: {
        userId: fixture.userId,
        amountUsd: '1234.56',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-mutation-pending'),
        depositAddress: 'TFixtureAddressMutation',
        payAmount: '1234.56000000',
        status: 'PENDING',
      },
    });
    const extraFailed = await prisma.deposit.create({
      data: {
        userId: fixture.userId,
        amountUsd: '4321.00',
        cryptoCurrency: 'usdttrc20',
        paymentId: fixturePaymentId('dep-mutation-failed'),
        depositAddress: 'TFixtureAddressMutation2',
        payAmount: '4321.00000000',
        status: 'FAILED',
      },
    });

    try {
      const withPending = await getAccountSnapshot(fixture.userId);
      expect(withPending.breakdown.equity.toFixed(2)).toBe(before.breakdown.equity.toFixed(2));
      expect(withPending.breakdown.confirmedDeposits.toFixed(2)).toBe(EXPECTED.confirmedDeposits);

      // 11500.00 + 500.00 + 1234.56 = 13234.56 credited
      // deployed     = 11000.00 (unchanged)
      // idle         = max(0, 13234.56 − 11000.00) = 2234.56
      // netContributed = 13234.56 − 1000.00 = 12234.56
      // equity         = 11000.00 + 2234.56 + 129.55 + 120.55 − 75.25 − 1000.00 = 12409.41
      await prisma.deposit.update({ where: { id: extraPending.id }, data: { status: 'CONFIRMED' } });
      const afterConfirm = await getAccountSnapshot(fixture.userId);
      expect(afterConfirm.breakdown.confirmedDeposits.toFixed(2)).toBe('2234.56');
      expect(afterConfirm.breakdown.equity.toFixed(2)).toBe('12409.41');
      // The equity delta is exactly the credited amount, never twice it.
      expect(D(afterConfirm.breakdown.equity).minus(D(before.breakdown.equity)).toFixed(2)).toBe('1234.56');

      // 13234.56 + 4321.00 = 17555.56 credited → idle 6555.56 → net 16555.56
      // equity = 11000.00 + 6555.56 + 129.55 + 120.55 − 75.25 − 1000.00 = 16730.41
      await prisma.deposit.update({ where: { id: extraFailed.id }, data: { status: 'FINISHED' } });
      const afterFailedToFinished = await getAccountSnapshot(fixture.userId);
      expect(afterFailedToFinished.breakdown.equity.toFixed(2)).toBe('16730.41');

      // ...and a status downgrade back to a non-credited state removes it again.
      await prisma.deposit.update({ where: { id: extraFailed.id }, data: { status: 'PENDING' } });
      expect((await getAccountSnapshot(fixture.userId)).breakdown.equity.toFixed(2)).toBe('12409.41');
    } finally {
      await prisma.deposit.deleteMany({ where: { id: { in: [extraPending.id, extraFailed.id] } } });
    }

    const restored = await getAccountSnapshot(fixture.userId);
    expect(restored.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
  });

  it('only a FINISHED withdrawal reduces equity (pending/in-flight is not debited)', async () => {
    const before = await getAccountSnapshot(fixture.userId);
    expect(before.breakdown.withdrawals.toFixed(2)).toBe(EXPECTED.withdrawals);
    expect(before.pendingWithdrawals.toFixed(2)).toBe(EXPECTED.pendingWithdrawals);
    expect(before.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);

    // The 250.00 PENDING withdrawal is only reserved — equity is untouched.
    await prisma.withdrawal.update({ where: { id: fixture.pendingWithdrawalId }, data: { status: 'FINISHED' } });
    try {
      // paid = 1000.00 + 250.00 = 1250.00; credited 12000.00 unchanged
      // idle = 1000.00 (unchanged), net = 12000.00 − 1250.00 = 10750.00
      // equity = 11000.00 + 1000.00 + 129.55 + 120.55 − 75.25 − 1250.00 = 10924.85
      const after = await getAccountSnapshot(fixture.userId);
      expect(after.breakdown.withdrawals.toFixed(2)).toBe('1250.00');
      expect(after.breakdown.equity.toFixed(2)).toBe('10924.85');
      expect(D(before.breakdown.equity).minus(D(after.breakdown.equity)).toFixed(2)).toBe('250.00');
      expect(after.pendingWithdrawals.toFixed(2)).toBe('100.00'); // only the SENDING row remains reserved
      // max(0, 10924.85 − 11000.00 − 100.00) = max(0, −175.15) = 0.00
      expect(after.withdrawableBalance.toFixed(2)).toBe('0.00');
    } finally {
      await prisma.withdrawal.update({ where: { id: fixture.pendingWithdrawalId }, data: { status: 'PENDING' } });
    }

    const restored = await getAccountSnapshot(fixture.userId);
    expect(restored.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
  });

  it('a second OPEN trade changes neither realized P/L nor equity (OPEN rows are never booked)', async () => {
    const before = await getAccountSnapshot(fixture.userId);
    const extra = await prisma.tradeRecord.create({
      data: {
        investmentId: fixture.activeInvestmentId,
        brokerId: fixture.brokerId,
        derivContractId: `${FIXTURE_TAG}-pos-mutation-open`,
        instrument: 'EURUSD',
        direction: 'SELL',
        volume: '1.00',
        entryPrice: '1.10000',
        grossPnL: '-9999.99',
        netPnL: '-9999.99',
        status: 'OPEN',
      },
    });
    try {
      const after = await getAccountSnapshot(fixture.userId);
      expect(after.breakdown.realizedPnL.toFixed(2)).toBe(before.breakdown.realizedPnL.toFixed(2));
      expect(after.breakdown.equity.toFixed(2)).toBe(before.breakdown.equity.toFixed(2));
    } finally {
      await prisma.tradeRecord.delete({ where: { id: extra.id } });
    }
  });

  it('closing that trade as a real CLOSED row moves realized P/L by its netPnL', async () => {
    const before = await getAccountSnapshot(fixture.userId);
    const row = await prisma.tradeRecord.create({
      data: {
        investmentId: fixture.activeInvestmentId,
        brokerId: fixture.brokerId,
        derivContractId: `${FIXTURE_TAG}-pos-mutation-closed`,
        instrument: 'EURUSD',
        direction: 'SELL',
        volume: '1.00',
        entryPrice: '1.10000',
        exitPrice: '1.09900',
        grossPnL: '100.00',
        netPnL: '100.00',
        status: 'CLOSED',
        closedAt: new Date('2026-08-03T10:00:00.000Z'),
      },
    });
    try {
      // realized = 129.55 + 100.00 = 229.55; equity = 11174.85 + 100.00 = 11274.85
      const after = await getAccountSnapshot(fixture.userId);
      expect(after.breakdown.realizedPnL.toFixed(2)).toBe('229.55');
      expect(after.breakdown.equity.toFixed(2)).toBe('11274.85');
      expect(D(after.breakdown.equity).minus(D(before.breakdown.equity)).toFixed(2)).toBe('100.00');
    } finally {
      await prisma.tradeRecord.delete({ where: { id: row.id } });
    }
  });

  it('a stored Investment.realizedPnL that disagrees with the trade rows is NOT trusted', async () => {
    // Provenance guard: realised P/L must be read from TradeRecord (the broker
    // events), never from the denormalised Investment column, which a partial or
    // interrupted sync could leave stale or inflated.
    await prisma.investment.update({
      where: { id: fixture.pausedInvestmentId },
      data: { realizedPnL: '7777.77' },
    });
    try {
      const snapshot = await getAccountSnapshot(fixture.userId);
      expect(snapshot.breakdown.realizedPnL.toFixed(2)).toBe(EXPECTED.realizedPnL);
      expect(snapshot.breakdown.realizedPnL.toFixed(2)).not.toBe('7907.32'); // 129.55 + 7777.77
      expect(snapshot.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
    } finally {
      await prisma.investment.update({
        where: { id: fixture.pausedInvestmentId },
        data: { realizedPnL: '0.00' },
      });
    }
  });

  it('unrealizedPnL is carried from the broker-written Investment column (never from netPnL of open rows)', async () => {
    // Investment.unrealizedPnL is the ONLY sanctioned source: it is written by the
    // broker sync worker from live MetaApi position state. An OPEN TradeRecord's
    // netPnL is not a position value and must never be substituted for it.
    await prisma.investment.update({
      where: { id: fixture.pausedInvestmentId },
      data: { unrealizedPnL: '4444.44' },
    });
    try {
      const snapshot = await getAccountSnapshot(fixture.userId);
      // 120.55 (ACTIVE investment) + 4444.44 (the injected broker value) = 4564.99
      expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).toBe('4564.99');
      // equity = 11174.85 + 4444.44 = 15619.29
      expect(snapshot.breakdown.equity.toFixed(2)).toBe('15619.29');
      // ...and it is reported once, exactly, not re-derived from the OPEN trade.
      expect(snapshot.breakdown.unrealizedPnL.toFixed(2)).not.toBe('5019.99'); // would double count the OPEN row's 555.00
    } finally {
      await prisma.investment.update({
        where: { id: fixture.pausedInvestmentId },
        data: { unrealizedPnL: '0.00' },
      });
    }
    expect((await getAccountSnapshot(fixture.userId)).breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
  });

  it('only ACTIVE/PAUSED capital is deployed; CLOSED capital is idle, never withdrawn-from thin air', async () => {
    const snapshot = await getAccountSnapshot(fixture.userId);

    const allCapital = await prisma.investment.aggregate({
      where: { userId: fixture.userId },
      _sum: { capitalUsd: true },
    });
    // 10000.00 + 1000.00 + 300.00 = 11300.00 across every investment, but only
    // 11000.00 is DEPLOYED (CLOSED capital is idle cash).
    expect(D(allCapital._sum.capitalUsd).toFixed(2)).toBe('11300.00');
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe(EXPECTED.startingCapital);
    expect(D(allCapital._sum.capitalUsd).minus(snapshot.breakdown.startingCapital).toFixed(2)).toBe('300.00');

    const closedInvestment = await prisma.investment.findUnique({ where: { id: fixture.closedInvestmentId } });
    expect(closedInvestment?.status).toBe('CLOSED');

    const deployedSum = await prisma.investment.aggregate({
      where: { userId: fixture.userId, status: { in: ['ACTIVE', 'PAUSED'] } },
      _sum: { capitalUsd: true },
    });
    expect(D(deployedSum._sum.capitalUsd).toFixed(2)).toBe(EXPECTED.activeCapital);
    expect(snapshot.activeCapital.toFixed(2)).toBe(EXPECTED.activeCapital);
    expect(snapshot.openInvestments).toBe(EXPECTED.openInvestments);

    // The CLOSED 300.00 is part of net contributed capital, so it is real money
    // the client still owns — it is just not LOCKED (not deployed).
    expect(snapshot.netContributedCapital.toFixed(2)).toBe(EXPECTED.netContributedCapital);
  });

  it('is deterministic: two consecutive snapshots are byte-identical', async () => {
    const first = await getAccountSnapshot(fixture.userId);
    const second = await getAccountSnapshot(fixture.userId);
    expect(JSON.stringify(toComparable(first))).toBe(JSON.stringify(toComparable(second)));
  });

  it('a user with no rows has a zero snapshot (no default capital, no invented balance)', async () => {
    const ghost = await prisma.user.create({
      data: {
        email: fixtureEmail('ghost'),
        passwordHash: 'fixture-not-a-real-argon2-hash',
        fullName: 'Verify Suite Ghost',
        country: 'KE',
        role: 'CLIENT',
        kycStatus: 'APPROVED',
      },
    });
    const snapshot = await getAccountSnapshot(ghost.id);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.netReturnPct.toFixed(4)).toBe('0.0000');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    expect(snapshot.openInvestments).toBe(0);
    await prisma.user.delete({ where: { id: ghost.id } });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REGRESSION BLOCK — the double-count, and the two holes that remain open in
  // src/. These are the most valuable tests in the repo: they make the
  // $2,000-from-$1,000 equity inflation impossible to reintroduce.
  // ══════════════════════════════════════════════════════════════════════════

  it('depositing then investing is equity-NEUTRAL (the double-count cannot return)', async () => {
    // X = 1000.00 is deposited and THEN deployed through the REAL service.
    const X = '1000.00';
    const user = await createScenarioUser('neutral');
    const plan = await createActivePlan('neutral');
    await creditDeposit(user.id, X, 'neutral-dep');

    const before = await getAccountSnapshot(user.id);

    // ── ARITHMETIC (before) ────────────────────────────────────────────────
    // credited = 1000.00, paid = 0.00, deployed = 0.00
    // netContributed = 1000.00, idle = max(0, 1000.00 − 0.00) = 1000.00
    // equity = 0.00 (deployed) + 1000.00 (idle) + 0 + 0 − 0 − 0 = 1000.00
    expect(before.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(before.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(before.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00');

    // Deploy the whole credited dollar through the real service (this is the
    // path that also enforces amountUsd <= withdrawableBalance).
    const invested = await createInvestment({
      user: sessionOf(user),
      planId: plan.id,
      amountUsd: 1000,
      ip: null,
    });
    expect(invested.status).toBe('ACTIVE');

    const after = await getAccountSnapshot(user.id);

    // ── ARITHMETIC (after) ─────────────────────────────────────────────────
    // deployed = 1000.00, netContributed = 1000.00, idle = max(0, 1000 − 1000) = 0.00
    // equity = 1000.00 (deployed) + 0.00 (idle) + 0 + 0 − 0 − 0 = 1000.00  ← UNCHANGED
    expect(after.breakdown.equity.toFixed(2)).toBe('1000.00');

    // Only the SPLIT moved: deployed up, idle down, total identical.
    expect(after.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
    expect(after.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(after.breakdown.startingCapital.plus(after.breakdown.confirmedDeposits).toFixed(2)).toBe('1000.00');
    expect(before.breakdown.startingCapital.plus(before.breakdown.confirmedDeposits).toFixed(2)).toBe('1000.00');

    // ── THE REGRESSION IS DOCUMENTED HERE ──────────────────────────────────
    // With the OLD (double-counted) formula this account read 2X = 2000.00:
    //   startingCapital := Σ ALL Investment.capitalUsd        = 1000.00
    //   confirmedDeposits := Σ ALL credited deposits          = 1000.00
    //   equity := 1000.00 + 1000.00 + P/L − fees − withdrawals = 2000.00
    // i.e. depositing $1,000 and investing it invented $1,000 of equity that the
    // client could then withdraw. Asserting `not 2X` here is the whole point.
    expect(after.breakdown.equity.toFixed(2)).not.toBe('2000.00');
  });

  it('deployed capital cannot exceed net contributed capital', async () => {
    const X = '1000.00';
    const user = await createScenarioUser('deploycap');
    const plan = await createActivePlan('deploycap');
    await creditDeposit(user.id, X, 'deploycap-dep');

    await createInvestment({ user: sessionOf(user), planId: plan.id, amountUsd: 1000, ip: null });

    const snapshot = await getAccountSnapshot(user.id);
    // deployed 1000.00 === netContributed 1000.00 === idle 0.00 → equity 1000.00
    expect(snapshot.breakdown.startingCapital.lessThanOrEqualTo(snapshot.netContributedCapital)).toBe(true);
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.netContributedCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');

    // THE AIR-WITHDRAWAL HOLE, closed at the investment gate: every credited
    // dollar is deployed, so there is nothing left to deploy again.
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
    await expect(
      createInvestment({ user: sessionOf(user), planId: plan.id, amountUsd: 100, ip: null }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('a withdrawal larger than the idle cash is impossible — the ledger sees 0.00 withdrawable', async () => {
    const user = await createScenarioUser('noworth');
    const plan = await createActivePlan('noworth');
    await creditDeposit(user.id, '1000.00', 'noworth-dep');
    await createInvestment({ user: sessionOf(user), planId: plan.id, amountUsd: 1000, ip: null });

    const snapshot = await getAccountSnapshot(user.id);
    // equity 1000.00 − deployed 1000.00 − pending 0.00 = 0.00
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');
  });

  /**
   * WAS `it.fails` while SRC DEFECT D2 was live (a private, pre-fix copy of the
   * formula in payments.service.ts let a fully-deployed account withdraw its own
   * deployed capital). Promoted to a passing `it` on 2026-09-23 when
   * `requestWithdrawal()` was pointed at the ledger's `getAccountSnapshot`.
   *
   * THE CONTRACT: the withdrawal ceiling IS the dashboard's `withdrawableBalance`.
   * Deployed capital is never withdrawable, so on a fully-deployed account any
   * positive request must throw INSUFFICIENT_FUNDS and create no row.
   */
  it('a withdrawal larger than the idle cash is impossible — requestWithdrawal rejects it', async () => {
    const user = await createScenarioUser('noworth-svc');
    const plan = await createActivePlan('noworth-svc');
    await creditDeposit(user.id, '1000.00', 'noworth-svc-dep');
    await createInvestment({ user: sessionOf(user), planId: plan.id, amountUsd: 1000, ip: null });

    // The dashboard and the withdrawal path read the SAME snapshot: 0.00 free.
    const snapshot = await getAccountSnapshot(user.id);
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('1000.00');
    expect(snapshot.activeCapital.toFixed(2)).toBe('1000.00');
    expect(snapshot.withdrawableBalance.toFixed(2)).toBe('0.00');

    await expect(
      requestWithdrawal({
        user: sessionOf(user),
        amountUsd: 0.01,
        cryptoCurrency: 'usdttrc20',
        payoutAddress: TRON_PAYOUT_ADDRESS,
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    // A rejected request must leave NOTHING behind: no withdrawal row, no
    // pending reservation that would shrink the next genuine request.
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
    expect((await getAccountSnapshot(user.id)).withdrawableBalance.toFixed(2)).toBe('0.00');
  });

  it('closing an investment returns its capital to idle and leaves equity untouched', async () => {
    const before = await getAccountSnapshot(fixture.userId);

    // Close the 10000.00 ACTIVE investment: its capital becomes idle cash.
    await prisma.investment.update({
      where: { id: fixture.activeInvestmentId },
      data: { status: 'CLOSED' },
    });
    try {
      const after = await getAccountSnapshot(fixture.userId);

      // deployed 11000.00 → 1000.00 (the PAUSED one is still deployed)
      // idle      1000.00 → 11000.00  (credited 12000.00 − deployed 1000.00)
      // equity = 1000.00 + 11000.00 + 129.55 + 120.55 − 75.25 − 1000.00 = 11174.85
      // ← byte-identical to before: moving capital between the two buckets is
      //   equity-neutral.
      expect(after.breakdown.equity.toFixed(2)).toBe(before.breakdown.equity.toFixed(2));
      expect(after.breakdown.equity.toFixed(2)).toBe(EXPECTED.equity);
      expect(after.breakdown.startingCapital.toFixed(2)).toBe('1000.00');
      expect(after.breakdown.confirmedDeposits.toFixed(2)).toBe('11000.00');
      // the partition total is invariant: it is GROSS credited capital, 12000.00
      expect(after.breakdown.startingCapital.plus(after.breakdown.confirmedDeposits).toFixed(2)).toBe(
        before.breakdown.startingCapital.plus(before.breakdown.confirmedDeposits).toFixed(2),
      );
      expect(after.breakdown.startingCapital.plus(after.breakdown.confirmedDeposits).toFixed(2)).toBe('12000.00');
    } finally {
      await prisma.investment.update({
        where: { id: fixture.activeInvestmentId },
        data: { status: 'ACTIVE' },
      });
    }

    expect((await getAccountSnapshot(fixture.userId)).breakdown.startingCapital.toFixed(2)).toBe(
      EXPECTED.startingCapital,
    );
  });

  it('a broker-sourced realised loss reduces equity, and the reduction equals the trade netPnL exactly', async () => {
    const before = await getAccountSnapshot(fixture.userId);
    const lossNetPnL = '-333.33';

    const loss = await prisma.tradeRecord.create({
      data: {
        investmentId: fixture.activeInvestmentId,
        brokerId: fixture.brokerId,
        derivContractId: `${FIXTURE_TAG}-pos-loss`,
        instrument: 'XAUUSD',
        direction: 'BUY',
        volume: '0.10',
        entryPrice: '2500.00000',
        exitPrice: '2466.66700',
        grossPnL: lossNetPnL,
        commission: '0.00',
        swap: '0.00',
        netPnL: lossNetPnL,
        status: 'CLOSED',
        closedAt: new Date('2026-08-04T10:00:00.000Z'),
      },
    });
    try {
      const after = await getAccountSnapshot(fixture.userId);
      // realized = 129.55 − 333.33 = −203.78
      // equity   = 11174.85 − 333.33 = 10841.52
      expect(after.breakdown.realizedPnL.toFixed(2)).toBe('-203.78');
      expect(after.breakdown.equity.toFixed(2)).toBe('10841.52');
      // The reduction is EXACTLY the trade's netPnL, to the cent — no float drift.
      expect(D(after.breakdown.equity).minus(D(before.breakdown.equity)).toFixed(2)).toBe(lossNetPnL);
    } finally {
      await prisma.tradeRecord.delete({ where: { id: loss.id } });
    }
  });

  /**
   * WAS `it.fails` while SRC DEFECT D1 was live; promoted to a passing `it` on
   * 2026-09-23. It is the smallest possible repro of the double-debit: an account
   * with IDLE cash and a FINISHED withdrawal, no investments at all.
   *
   * deposit 1000.00 CONFIRMED, withdraw 400.00 FINISHED, no investments:
   *   deployed 0.00, credited 1000.00, paid 400.00
   *   idle = max(0, credited − deployed) = 1000.00   ← GROSS, not net-of-paid
   *   netContributed = 1000.00 − 400.00 = 600.00
   *   equity = 0.00 + 1000.00 + 0 P/L − 0 fees − 400.00 = 600.00
   *
   * The old (double-debit) ledger reported 200.00 — the client's own remaining
   * money understated by the FINISHED withdrawal, counted twice.
   */
  it('finished withdrawals are debited exactly once when idle cash exists (D1 regression)', async () => {
    const user = await createScenarioUser('d1-idle');
    await creditDeposit(user.id, '1000.00', 'd1-idle-dep');
    await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: '400.00',
        cryptoCurrency: 'usdttrc20',
        payoutAddress: 'TFixturePayoutD1',
        status: 'FINISHED',
      },
    });

    const snapshot = await getAccountSnapshot(user.id);
    // ledger bookkeeping, asserted first so the failure message is precise
    expect(snapshot.breakdown.startingCapital.toFixed(2)).toBe('0.00');
    expect(snapshot.breakdown.confirmedDeposits.toFixed(2)).toBe('1000.00'); // idle = credited − deployed
    expect(snapshot.breakdown.withdrawals.toFixed(2)).toBe('400.00');
    expect(snapshot.netContributedCapital.toFixed(2)).toBe('600.00'); // 1000.00 − 400.00

    // THE CONTRACT: the client deposited 1000.00, withdrew 400.00, so 600.00 is
    // still theirs — and equity says so to the cent.
    expect(snapshot.breakdown.equity.toFixed(2)).toBe('600.00');
    expect(snapshot.breakdown.equity.toFixed(2)).not.toBe('200.00'); // the double-debit

    // Both identities hold:
    //   (I)  0.00 + 1000.00 − 400.00 = 600.00 ✓
    //   (II) 600.00 + 0.00 + 0.00 − 0.00 = 600.00 ✓
    expect(
      snapshot.breakdown.startingCapital
        .plus(snapshot.breakdown.confirmedDeposits)
        .minus(snapshot.breakdown.withdrawals)
        .toFixed(2),
    ).toBe('600.00');
    expect(
      snapshot.netContributedCapital
        .plus(snapshot.breakdown.realizedPnL)
        .plus(snapshot.breakdown.unrealizedPnL)
        .minus(snapshot.breakdown.deductedFees)
        .toFixed(2),
    ).toBe('600.00');
  });

  itDb('(guard) the fixture user still exists and is tagged for cleanup', async () => {
    const user = await prisma.user.findUnique({ where: { id: fixture.userId } });
    expect(user?.email.startsWith(`${FIXTURE_TAG}-`)).toBe(true);
  });
});

function toComparable(snapshot: Awaited<ReturnType<typeof getAccountSnapshot>>) {
  return {
    equity: snapshot.breakdown.equity.toFixed(2),
    startingCapital: snapshot.breakdown.startingCapital.toFixed(2),
    confirmedDeposits: snapshot.breakdown.confirmedDeposits.toFixed(2),
    netContributedCapital: snapshot.netContributedCapital.toFixed(2),
    realized: snapshot.breakdown.realizedPnL.toFixed(2),
    unrealized: snapshot.breakdown.unrealizedPnL.toFixed(2),
    active: snapshot.activeCapital.toFixed(2),
    pending: snapshot.pendingWithdrawals.toFixed(2),
    withdrawable: snapshot.withdrawableBalance.toFixed(2),
    open: snapshot.openInvestments,
  };
}
