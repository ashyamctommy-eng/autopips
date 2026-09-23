import { describe, it, expect } from 'vitest';
import { Decimal, D } from '@/lib/money';
import { computeManagementFee, computePerformanceFee } from '@/server/modules/bot/fee.engine';

/**
 * FEE ENGINE SUITE (pure calculators).
 *
 * Management fee:   capital × (annualPct / 100) × (daysElapsed / 365), 2 dp.
 * Performance fee:  HIGH-WATER MARK — fee only on profit above the previous
 *                   high, never on profit the client already paid for.
 *
 * A fee is a debit, so "cannot evaluate" must never charge the client something
 * invented: non-finite / non-positive inputs produce an exact zero.
 *
 * The "fees never drive value below zero" property is enforced by the solvency
 * clamp in `applyFees` (the only DB-touching function here); it is proven in
 * tests/integration-ledger.test.ts, where a real Investment row is decremented.
 */

function money(value: Decimal | number | string): string {
  return D(value).toFixed(2);
}

describe('computeManagementFee (pro-rata)', () => {
  it('charges nothing for zero elapsed days (a real zero, not a substituted value)', () => {
    expect(money(computeManagementFee({ capitalUsd: '10000.00', annualPct: '1.5', daysElapsed: 0 }))).toBe('0.00');
  });

  it('charges exactly annualPct of capital over a full year (365-day basis)', () => {
    // 10000 × 1.5% = 150.00
    expect(money(computeManagementFee({ capitalUsd: '10000.00', annualPct: '1.5', daysElapsed: 365 }))).toBe('150.00');
  });

  it('prorates to whole cents: 10000 × 1.5% × 182/365 = 74.79', () => {
    expect(money(computeManagementFee({ capitalUsd: '10000.00', annualPct: '1.5', daysElapsed: 182 }))).toBe('74.79');
  });

  it('is linear in days for a fixed capital: half a year is half the fee', () => {
    const half = D(computeManagementFee({ capitalUsd: '10000.00', annualPct: '2', daysElapsed: 182.5 }));
    const full = D(computeManagementFee({ capitalUsd: '10000.00', annualPct: '2', daysElapsed: 365 }));
    expect(money(full)).toBe('200.00');
    expect(money(half)).toBe('100.00');
  });

  it('never charges a negative fee: negative days/capital/pct and non-finite inputs are all zero', () => {
    expect(money(computeManagementFee({ capitalUsd: '10000', annualPct: '1.5', daysElapsed: -30 }))).toBe('0.00');
    expect(money(computeManagementFee({ capitalUsd: '-10000', annualPct: '1.5', daysElapsed: 100 }))).toBe('0.00');
    expect(money(computeManagementFee({ capitalUsd: '10000', annualPct: '-1.5', daysElapsed: 100 }))).toBe('0.00');
    expect(money(computeManagementFee({ capitalUsd: '10000', annualPct: '1.5', daysElapsed: Number.NaN }))).toBe('0.00');
    expect(money(computeManagementFee({ capitalUsd: '10000', annualPct: '1.5', daysElapsed: Number.POSITIVE_INFINITY }))).toBe(
      '0.00',
    );
    expect(money(computeManagementFee({ capitalUsd: 0, annualPct: '1.5', daysElapsed: 365 }))).toBe('0.00');
  });

  it('stays exact in Decimal for a cent-sized fee (no float artefact)', () => {
    // 1000.01 × 0.01% × 365/365 = 0.100001 → 0.10
    expect(money(computeManagementFee({ capitalUsd: '1000.01', annualPct: '0.01', daysElapsed: 365 }))).toBe('0.10');
  });
});

describe('computePerformanceFee (high-water mark)', () => {
  it('charges 20% of the profit above the previous high: 10000 → 11000 with HWM 10000 → 200.00', () => {
    const result = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10000.00',
      currentEquity: '11000.00',
      performanceFeePct: '20',
    });
    expect(money(result.fee)).toBe('200.00');
    expect(money(result.highWaterMark)).toBe('10000.00');
    expect(money(result.profitAboveHwm)).toBe('1000.00');
    expect(result.isNewHigh).toBe(true);
  });

  it('charges fee on the INCREMENT only, not on the whole equity', () => {
    const result = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '12000.00', // client already paid performance above 12000
      currentEquity: '12001.00',
      performanceFeePct: '20',
    });
    expect(money(result.fee)).toBe('0.20'); // 20% of 1.00, not 20% of 2001.00
    expect(money(result.profitAboveHwm)).toBe('1.00');
  });

  it('charges nothing when there is no new high (equity below or equal to the HWM)', () => {
    const below = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '11000.00',
      currentEquity: '10500.00',
      performanceFeePct: '20',
    });
    expect(money(below.fee)).toBe('0.00');
    expect(below.isNewHigh).toBe(false);
    expect(money(below.profitAboveHwm)).toBe('0.00'); // never a negative "profit"

    const equal = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '11000.00',
      currentEquity: '11000.00',
      performanceFeePct: '20',
    });
    expect(money(equal.fee)).toBe('0.00');
    expect(equal.isNewHigh).toBe(false);
  });

  it('a client who lost money is not charged: negative P/L → 0.00', () => {
    const result = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10000.00',
      currentEquity: '9000.00',
      performanceFeePct: '20',
    });
    expect(money(result.fee)).toBe('0.00');
    expect(result.isNewHigh).toBe(false);
    expect(money(result.profitAboveHwm)).toBe('0.00');
  });

  it('the fee never exceeds the profit it is charged on (a fee cannot create a loss)', () => {
    for (const [capital, peak, current, pct] of [
      ['10000.00', '10000.00', '11000.00', '20'],
      ['10000.00', '10000.00', '10100.00', '20'],
      ['500.00', '500.00', '500.01', '50'],
      ['10000.00', '10000.00', '100000.00', '99.99'],
    ] as const) {
      const result = computePerformanceFee({
        startingCapital: capital,
        peakEquity: peak,
        currentEquity: current,
        performanceFeePct: pct,
      });
      expect(D(result.fee).lessThanOrEqualTo(D(result.profitAboveHwm))).toBe(true);
      expect(D(result.fee).isNegative()).toBe(false);
      // ...and collecting the fee cannot push equity below the high-water mark.
      const equityAfter = new Decimal(current).minus(result.fee);
      expect(equityAfter.greaterThanOrEqualTo(new Decimal(result.highWaterMark))).toBe(true);
    }
  });

  it('the HWM is max(startingCapital, peakEquity): a peak below capital still charges only above capital', () => {
    const result = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '5000.00', // e.g. a stored watermark polluted by a partial sync
      currentEquity: '10500.00',
      performanceFeePct: '50',
    });
    expect(money(result.highWaterMark)).toBe('10000.00');
    expect(money(result.profitAboveHwm)).toBe('500.00');
    expect(money(result.fee)).toBe('250.00');
  });

  it('zero or negative performance pct charges nothing; non-finite inputs are zero, never NaN', () => {
    const base = { startingCapital: '10000', peakEquity: '10000', currentEquity: '11000' };
    expect(money(computePerformanceFee({ ...base, performanceFeePct: '0' }).fee)).toBe('0.00');
    expect(money(computePerformanceFee({ ...base, performanceFeePct: '-20' }).fee)).toBe('0.00');
    expect(money(computePerformanceFee({ ...base, performanceFeePct: Number.NaN }).fee)).toBe('0.00');
    expect(money(computePerformanceFee({ ...base, performanceFeePct: Number.POSITIVE_INFINITY }).fee)).toBe('0.00');
    const nonFinite = computePerformanceFee({
      startingCapital: Number.NaN,
      peakEquity: Number.NaN,
      currentEquity: Number.NaN,
      performanceFeePct: '20',
    });
    expect(money(nonFinite.fee)).toBe('0.00');
    expect(nonFinite.isNewHigh).toBe(false);
    expect(Number.isFinite(D(nonFinite.fee).toNumber())).toBe(true);
  });

  it('quantises to cents with ROUND_HALF_UP: 20% of 1000.03 → 200.01', () => {
    const result = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10000.00',
      currentEquity: '11000.03',
      performanceFeePct: '20',
    });
    expect(money(result.profitAboveHwm)).toBe('1000.03');
    expect(money(result.fee)).toBe('200.01'); // 200.006 → 200.01
  });

  it('a management + performance pair is additive and each component stays individually auditable', () => {
    const management = D(computeManagementFee({ capitalUsd: '10000', annualPct: '1.5', daysElapsed: 365 }));
    const performance = computePerformanceFee({
      startingCapital: '10000',
      peakEquity: '10000',
      currentEquity: '11000',
      performanceFeePct: '20',
    });
    expect(money(management)).toBe('150.00');
    expect(money(performance.fee)).toBe('200.00');
    expect(money(management.plus(performance.fee))).toBe('350.00');
    // Total fees (350) are payable out of the 1000 profit — the account stays
    // solvent, which is why the clamp is a backstop and not the normal path.
    expect(D('10000').plus('1000').minus(management).minus(performance.fee).greaterThanOrEqualTo(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyFees: the SOLVENCY CLAMP — "a fee can never push currentValUsd below 0".
// This is the only fee path that touches the database, so it is proven against
// the live Postgres + Redis (the high-water mark lives in Redis) and skipped
// with a loud message when either is unreachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { rkey } from '@/lib/redis';
import { AUDIT_FEE_APPLIED, applyFees } from '@/server/modules/bot/fee.engine';
import {
  FIXTURE_TAG,
  assertNoFixtureRowsLeft,
  fixtureEmail,
  isDatabaseReachable,
  isRedisReachable,
  purgeFixtures,
  trackRedisKey,
} from './helpers/fixtures';
import './helpers/test-env';

const databaseReachable = await isDatabaseReachable();
const redisReachable = databaseReachable ? await isRedisReachable() : false;
const feeDepsReady = databaseReachable && redisReachable;
if (!feeDepsReady) {
  console.warn(
    `[fees] SKIPPED solvency-clamp integration block: database=${
      databaseReachable ? 'up' : 'down'
    }, redis=${redisReachable ? 'up' : 'down'}.`,
  );
}
const describeFees = feeDepsReady ? describe : describe.skip;

describeFees('applyFees: solvency clamp against the live ledger', () => {
  let userId = '';
  let planId = '';
  let investmentId = '';
  let insolventInvestmentId = '';

  beforeAll(async () => {
    await purgeFixtures();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('fees'),
        passwordHash: 'fixture-not-a-real-argon2-hash',
        fullName: 'Verify Suite Fees Fixture',
        country: 'KE',
        role: 'CLIENT',
        kycStatus: 'APPROVED',
      },
    });
    userId = user.id;

    const plan = await prisma.tradingPlan.create({
      data: {
        name: `${FIXTURE_TAG} fees plan`,
        description: 'verification-suite fixture plan',
        minInvestment: '10.00',
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
    planId = plan.id;

    const solvent = await prisma.investment.create({
      data: {
        userId,
        planId,
        capitalUsd: '10000.00',
        currentValUsd: '10000.00',
        status: 'ACTIVE',
      },
    });
    investmentId = solvent.id;

    const insolvent = await prisma.investment.create({
      data: {
        userId,
        planId,
        capitalUsd: '100.00',
        currentValUsd: '100.00',
        status: 'ACTIVE',
      },
    });
    insolventInvestmentId = insolvent.id;
    trackRedisKey(rkey('investment-hwm', insolvent.id));
    trackRedisKey(rkey('investment-hwm', solvent.id));
  });

  afterAll(async () => {
    if (!feeDepsReady) return;
    const report = await purgeFixtures();
    console.log(`[fees] fixture cleanup (tag ${FIXTURE_TAG}):`, report);
    await assertNoFixtureRowsLeft();
  });

  it('charges a management fee and can never push currentValUsd below zero', async () => {
    // 100.00 capital with a 1000% annual fee over a full year requests 1000.00 —
    // ten times the equity. The clamp charges 100.00 and stops at zero.
    const result = await applyFees({
      investmentId: insolventInvestmentId,
      management: { annualPct: 1000, daysElapsed: 365 },
      userId,
    });

    expect(result.managementFee).toBe(1000);
    expect(result.charged).toBe(100);
    expect(result.clamped).toBe(true);
    expect(result.feesDeductedAfter).toBe(100);
    expect(result.currentValUsdAfter).toBe(0);
    expect(result.currentValUsdAfter).toBeGreaterThanOrEqual(0);

    const stored = await prisma.investment.findUnique({ where: { id: insolventInvestmentId } });
    expect(D(stored?.currentValUsd ?? 0).toFixed(2)).toBe('0.00');
    expect(D(stored?.feesDeducted ?? 0).toFixed(2)).toBe('100.00');
    // A fee is not a trade: no TradeRecord may be fabricated for it.
    const fabricated = await prisma.tradeRecord.count({ where: { investmentId: insolventInvestmentId } });
    expect(fabricated).toBe(0);
  });

  it('a second fee on an exhausted account charges nothing and records the refusal', async () => {
    const result = await applyFees({
      investmentId: insolventInvestmentId,
      management: { annualPct: 1000, daysElapsed: 365 },
      userId,
    });
    expect(result.charged).toBe(0);
    expect(result.clamped).toBe(true);
    expect(result.currentValUsdAfter).toBe(0);

    const stored = await prisma.investment.findUnique({ where: { id: insolventInvestmentId } });
    expect(D(stored?.currentValUsd ?? 0).isNegative()).toBe(false);

    const audits = await prisma.auditLog.findMany({ where: { userId, action: AUDIT_FEE_APPLIED } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const refusal = audits.find((row) => (row.details as Record<string, unknown>).reason === 'NO_CHARGEABLE_EQUITY');
    expect(refusal).toBeDefined();
  });

  it('a performance fee only ever charges the increment above the stored high-water mark', async () => {
    // Profit 1000.00 above the funded capital → 20% = 200.00.
    await prisma.investment.update({
      where: { id: investmentId },
      data: { unrealizedPnL: '1000.00', currentValUsd: '11000.00' },
    });

    const first = await applyFees({ investmentId, performance: { performanceFeePct: 20 }, userId });
    expect(first.performanceFee).toBe(200);
    expect(first.charged).toBe(200);
    expect(first.isNewHigh).toBe(true);
    expect(first.feesDeductedAfter).toBe(200);
    expect(first.currentValUsdAfter).toBe(10800);
    // The watermark is now the post-fee equity, in Redis.
    const watermark = await import('@/lib/redis').then(({ redis }) => redis.get(rkey('investment-hwm', investmentId)));
    expect(Number(watermark)).toBe(10800);

    // No new high → no fee, and no fabricated profit.
    const second = await applyFees({ investmentId, performance: { performanceFeePct: 20 }, userId });
    expect(second.performanceFee).toBe(0);
    expect(second.charged).toBe(0);
    expect(second.isNewHigh).toBe(false);

    // A new high above the watermark charges only the increment (100.00 → 20.00).
    await prisma.investment.update({ where: { id: investmentId }, data: { unrealizedPnL: '1100.00' } });
    const third = await applyFees({ investmentId, performance: { performanceFeePct: 20 }, userId });
    expect(third.performanceFee).toBe(20); // 20% of the 100.00 increment, not of the 10900 equity
    expect(third.clamped).toBe(false);
    expect(third.feesDeductedAfter).toBe(220); // 200.00 + 20.00
    expect(third.currentValUsdAfter).toBe(10880); // 10000 + 1100 - 220
  });

  it('fees are recorded in feesDeducted (equity debit) and never as an invented trade', async () => {
    const stored = await prisma.investment.findUnique({ where: { id: investmentId } });
    expect(D(stored?.feesDeducted ?? 0).toFixed(2)).toBe('220.00');
    const trades = await prisma.tradeRecord.count({ where: { investmentId } });
    expect(trades).toBe(0);
  });
});
