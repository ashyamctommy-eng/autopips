import './helpers/test-env';

import { describe, expect, it } from 'vitest';
import { D, type Numeric } from '@/lib/money';
import {
  computeManagementFee,
  computePerformanceFee,
  raiseHighWaterMark,
  resolveStoredHighWaterMark,
  type PerformanceFeeResult,
} from '@/server/modules/bot/fee.engine';
import {
  daysElapsedSince,
  feeAccrualAnchor,
  hasChargeableFees,
  utcDayKey,
} from '@/server/modules/bot/fee.accrual';

/**
 * PURE fee-accrual rules.
 *
 * These are the decisions that make the fee engine idempotent and fair, isolated
 * from the database so a failure here is a logic defect, not a fixture problem:
 *
 *   * the period anchor (`lastFeeAt ?? startDate`) and the day-count derived from
 *     it, including "a second run on the same day accrues ~nothing";
 *   * the high-water-mark rules (no fee below the mark, the mark only ever rises,
 *     a durable mark survives a simulated cache miss);
 *   * a zero-fee plan is a no-op.
 *
 * The transactional behaviour of `applyFees` (row lock, atomic increment, the
 * solvency clamp) is proven against the live database in tests/fees.test.ts.
 */

function money(value: Numeric): string {
  return D(value).toFixed(2);
}

describe('accrual period anchor: lastFeeAt wins, startDate only seeds the first run', () => {
  const started = new Date('2026-09-01T00:00:00.000Z');
  const firstAccrual = new Date('2026-09-02T00:00:00.000Z');

  it('seeds the first period from startDate when no fee has been taken yet', () => {
    expect(feeAccrualAnchor({ lastFeeAt: null, startDate: started })).toEqual(started);
  });

  it('uses the previous accrual once one exists, NOT startDate', () => {
    expect(feeAccrualAnchor({ lastFeeAt: firstAccrual, startDate: started })).toEqual(firstAccrual);
  });

  it('is null when there is neither an anchor nor a start date (nothing to charge)', () => {
    expect(feeAccrualAnchor({ lastFeeAt: null, startDate: null })).toBeNull();
  });

  it('reports no elapsed time (not a negative one) when the clock runs backwards', () => {
    expect(daysElapsedSince(firstAccrual, started)).toBe(0);
    expect(daysElapsedSince(firstAccrual, firstAccrual)).toBe(0);
  });

  it('counts exactly one day between midnight-to-midnight accruals', () => {
    expect(daysElapsedSince(started, firstAccrual)).toBeCloseTo(1, 10);
  });

  it('a second run on the same day accrues ~nothing, while re-reading startDate would re-charge the day', () => {
    const capital = '10000.00';
    const annualPct = '1.5';

    // Run 1: one whole day since startDate -> ~0.41 management fee.
    const firstElapsed = daysElapsedSince(feeAccrualAnchor({ lastFeeAt: null, startDate: started })!, firstAccrual);
    const firstFee = computeManagementFee({ capitalUsd: capital, annualPct, daysElapsed: firstElapsed });
    expect(money(firstFee)).toBe('0.41');

    // Run 1 advanced the anchor to its own instant.
    const anchorAfterFirst = feeAccrualAnchor({ lastFeeAt: firstAccrual, startDate: started });

    // Run 2: ten seconds later, on the SAME day. The elapsed period is seconds,
    // so the fee quantises to nothing.
    const secondRun = new Date('2026-09-02T00:00:10.000Z');
    const secondElapsed = daysElapsedSince(anchorAfterFirst!, secondRun);
    expect(secondElapsed).toBeLessThan(0.001);
    expect(money(computeManagementFee({ capitalUsd: capital, annualPct, daysElapsed: secondElapsed }))).toBe('0.00');

    // The defect this anchor prevents: anchoring on startDate again would charge
    // the whole first day a SECOND time.
    const naiveElapsed = daysElapsedSince(started, secondRun);
    expect(money(computeManagementFee({ capitalUsd: capital, annualPct, daysElapsed: naiveElapsed }))).toBe('0.41');
    expect(D(naiveElapsed).greaterThan(1)).toBe(true);
  });

  it('a week of downtime is ONE catch-up charge for seven days, not seven daily charges', () => {
    const downForAWeek = new Date('2026-09-08T00:00:00.000Z');
    const elapsed = daysElapsedSince(feeAccrualAnchor({ lastFeeAt: started, startDate: started })!, downForAWeek);
    expect(elapsed).toBeCloseTo(7, 10);
    // 10000 x 1.5% x 7/365 = 2.8767 -> 2.88, once.
    expect(money(computeManagementFee({ capitalUsd: '10000', annualPct: '1.5', daysElapsed: elapsed }))).toBe('2.88');
  });

  it('the claim key period is the UTC day of the run', () => {
    expect(utcDayKey(new Date('2026-09-02T23:59:59.999Z'))).toBe('2026-09-02');
    expect(utcDayKey(new Date('2026-09-03T00:00:00.000Z'))).toBe('2026-09-03');
  });
});

describe('high-water mark: durable copy is the authority', () => {
  it('never charges performance below the stored mark', () => {
    const atMark = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10800.00',
      currentEquity: '10800.00',
      performanceFeePct: '20',
    });
    expect(money(atMark.fee)).toBe('0.00');
    expect(atMark.isNewHigh).toBe(false);

    const belowMark = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10800.00',
      currentEquity: '10500.00',
      performanceFeePct: '20',
    });
    expect(money(belowMark.fee)).toBe('0.00');
    expect(belowMark.isNewHigh).toBe(false);
  });

  it('the mark only ever rises: a lower or equal candidate leaves it untouched', () => {
    expect(money(raiseHighWaterMark('10800.00', '10500.00'))).toBe('10800.00');
    expect(money(raiseHighWaterMark('10800.00', '10800.00'))).toBe('10800.00');
    expect(money(raiseHighWaterMark('10800.00', '11000.00'))).toBe('11000.00');
    expect(money(raiseHighWaterMark(null, '10000.00'))).toBe('10000.00');
    // A non-finite candidate is not a new high.
    expect(money(raiseHighWaterMark('10800.00', Number.NaN))).toBe('10800.00');
    expect(money(raiseHighWaterMark(null, Number.NaN))).toBe('0.00');
  });

  it('a durable mark survives a simulated cache miss, and a cache entry can never lower it', () => {
    // Redis flushed: no cached value, the DB copy still answers.
    expect(resolveStoredHighWaterMark('10800.00', null)).toEqual({ value: 10800, promote: false });
    // A stale/lower cache entry loses to the durable copy.
    expect(resolveStoredHighWaterMark('10800.00', '9000.00')).toEqual({ value: 10800, promote: false });
    // A non-finite cache entry loses too.
    expect(resolveStoredHighWaterMark('10800.00', Number.NaN)).toEqual({ value: 10800, promote: false });
    // Only a pre-migration row (no durable copy) may use the cache - and then the
    // value is promoted so the next flush cannot lose it.
    expect(resolveStoredHighWaterMark(null, '10800.00')).toEqual({ value: 10800, promote: true });
    expect(resolveStoredHighWaterMark(null, null)).toEqual({ value: null, promote: false });
  });

  it('after a durable mark is lost from a cache, recovering equity to that mark is charged NOTHING', () => {
    // Sequence: equity 10000 -> 11000, a 20% performance fee is crystallised, so
    // the post-fee equity (10800) becomes the durable mark. The client then drops
    // to 10500 and climbs back to 10800: nothing is owed on the recovery.
    const first = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: '10000.00',
      currentEquity: '11000.00',
      performanceFeePct: '20',
    });
    const markAfterFirstFee = raiseHighWaterMark('10000.00', D('11000.00').minus(first.fee).toFixed(2));
    expect(money(markAfterFirstFee)).toBe('10800.00');

    // Simulate a Redis flush: the cached mark is gone; the durable value answers.
    const durable = resolveStoredHighWaterMark(markAfterFirstFee.toFixed(2), null);
    expect(durable.value).toBe(10800);

    const recovery = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: D(durable.value!).toFixed(2),
      currentEquity: '10800.00',
      performanceFeePct: '20',
    });
    expect(money(recovery.fee)).toBe('0.00');
    expect(recovery.isNewHigh).toBe(false);

    // A genuine new high above 10800 charges only the increment (200.00 -> 40.00)
    // and the mark rises by the same rule.
    const newHigh: PerformanceFeeResult = computePerformanceFee({
      startingCapital: '10000.00',
      peakEquity: D(durable.value!).toFixed(2),
      currentEquity: '11000.00',
      performanceFeePct: '20',
    });
    expect(money(newHigh.fee)).toBe('40.00');
    expect(money(raiseHighWaterMark(D(durable.value!).toFixed(2), D('11000.00').minus(newHigh.fee).toFixed(2)))).toBe(
      '10960.00',
    );
  });
});

describe('a zero-fee plan is a no-op', () => {
  it('reports no chargeable fee only when BOTH components are zero', () => {
    expect(hasChargeableFees({ managementFee: '0.00', performanceFee: '0.00' })).toBe(false);
    expect(hasChargeableFees({ managementFee: 0, performanceFee: 0 })).toBe(false);
    expect(hasChargeableFees({ managementFee: Number.NaN, performanceFee: Number.NaN })).toBe(false);
    expect(hasChargeableFees({ managementFee: '1.50', performanceFee: '0.00' })).toBe(true);
    expect(hasChargeableFees({ managementFee: '0.00', performanceFee: '20.00' })).toBe(true);
  });

  it('a month of elapsed time on a zero-fee plan charges exactly nothing', () => {
    const plan = { managementFee: '0.00', performanceFee: '0.00' };
    expect(hasChargeableFees(plan)).toBe(false);
    // Even if the pass did evaluate the calculators, zero percentages charge zero.
    const management = computeManagementFee({ capitalUsd: '10000', annualPct: plan.managementFee, daysElapsed: 30 });
    const performance = computePerformanceFee({
      startingCapital: '10000',
      peakEquity: '10000',
      currentEquity: '12000',
      performanceFeePct: plan.performanceFee,
    });
    expect(money(management)).toBe('0.00');
    expect(money(performance.fee)).toBe('0.00');
    expect(performance.isNewHigh).toBe(false);
  });
});
