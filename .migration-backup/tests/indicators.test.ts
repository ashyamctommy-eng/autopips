import { describe, it, expect } from 'vitest';
import { D, Decimal } from '@/lib/money';
import { ema, rsi } from '@/server/modules/bot/strategy.engine';

/**
 * INDICATOR SUITE (ema / rsi).
 *
 * These are the only two places a documented epsilon is acceptable: they return
 * IEEE-754 doubles by contract (`Array<number | null>`), so the assertions below
 * state the expected hand-computed value and compare with an explicit tolerance
 * that is tighter than any value the strategy rule depends on.
 *
 * Degenerate inputs must produce empty/null results — never NaN. A NaN leaking
 * into a signal would compare false against every threshold and silently disable
 * the RSI confirmation guard.
 */

const EPS = 1e-3;

function finiteOrNull(series: Array<number | null>): boolean {
  return series.every((value) => value === null || Number.isFinite(value));
}

describe('ema', () => {
  it('seeds with the SMA of the first period and smooths after: [1,2,3,4,5] period 3 → [null,null,2,3,4]', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('is exactly the SMA on a flat series', () => {
    const result = ema([2, 2, 2, 2, 2], 3);
    expect(result[2]).toBeCloseTo(2, 12);
    expect(result[3]).toBeCloseTo(2, 12);
    expect(result[4]).toBeCloseTo(2, 12);
  });

  it('period 1 mirrors the input exactly', () => {
    expect(ema([5, 7, 9], 1)).toEqual([5, 7, 9]);
  });

  it('uses multiplier 2/(period+1): period 3 → 0.5, so a jump to 10 moves the EMA halfway', () => {
    // seed = 2 (SMA of 1,2,3); next input 10 → 2 + (10-2)*0.5 = 6
    const result = ema([1, 2, 3, 10], 3);
    expect(result[3]).toBeCloseTo(6, 12);
  });

  it('keeps the series length and the leading null alignment', () => {
    const values = [3, 1, 4, 1, 5, 9, 2];
    const result = ema(values, 4);
    expect(result).toHaveLength(values.length);
    expect(result.slice(0, 3)).toEqual([null, null, null]);
    expect(result[3]).not.toBeNull();
  });

  it('degenerate inputs return an all-null series of the right length (never NaN)', () => {
    expect(ema([], 3)).toEqual([]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
    expect(ema([1, 2, 3], 0)).toEqual([null, null, null]);
    expect(ema([1, 2, 3], -2)).toEqual([null, null, null]);
    expect(finiteOrNull(ema([1, 2, 3, 4, 5], 10))).toBe(true);
  });

  it('is deterministic: the same series yields identical output twice', () => {
    const values = [1.5, 2.25, 3, 4.75, 5.5, 6.125, 7];
    expect(ema(values, 3)).toEqual(ema(values, 3));
  });
});

describe('rsi (Wilder smoothing)', () => {
  /**
   * Hand-computed Wilder RSI for closes [10, 11, 12, 11, 12, 13], period 3:
   *   seed (i=3): gains 2, losses 1 → avgGain 2/3, avgLoss 1/3
   *               RS = 2 → RSI = 100 − 100/(1+2)            = 66.6667
   *   i=4 (+1):   avgGain = (2/3·2 + 1)/3 = 7/9, avgLoss = (1/3·2)/3 = 2/9
   *               RS = 3.5 → RSI = 100 − 100/4.5            = 77.7778
   *   i=5 (+1):   avgGain = (7/9·2 + 1)/3 = 23/27, avgLoss = (2/9·2)/3 = 4/27
   *               RS = 5.75 → RSI = 100 − 100/6.75          = 85.1852
   */
  const closes = [10, 11, 12, 11, 12, 13];

  it('matches the hand-computed Wilder values for a small series', () => {
    const result = rsi(closes, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
    expect(result[3]).toBeCloseTo(66.6667, 3);
    expect(result[4]).toBeCloseTo(77.7778, 3);
    expect(result[5]).toBeCloseTo(85.1852, 3);
    expect(finiteOrNull(result)).toBe(true);
  });

  it('returns 100 when there are no losses, and null for a perfectly flat series', () => {
    // flat: avgGain = avgLoss = 0 → there is no honest RSI value
    expect(rsi([5, 5, 5, 5, 5], 3).slice(3)).toEqual([null, null]);
    // strictly rising: no losses → RS = ∞ → RSI 100
    expect(rsi([1, 2, 3, 4, 5], 3)[3]).toBeCloseTo(100, 6);
  });

  it('agrees with an independent Wilder implementation on the classic 14-period series', () => {
    const values = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
    ];
    const period = 14;
    const actual = rsi(values, period);
    const expected = independentWilderRsi(values, period);
    expect(expected).not.toBeNull();

    // Published reference value for this well-known series is ≈70.46.
    expect(actual[period]).not.toBeNull();
    expect(actual[period] as number).toBeGreaterThan(70);
    expect(actual[period] as number).toBeLessThan(70.9);
    expect(actual[period] as number).toBeCloseTo(expected as number, 2);
    expect(finiteOrNull(actual)).toBe(true);
  });

  it('degenerate inputs return an all-null series of the right length (never NaN)', () => {
    expect(rsi([], 3)).toEqual([]);
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]); // needs period + 1 values
    expect(rsi([1, 2, 3, 4], 0)).toEqual([null, null, null, null]);
    expect(rsi([1, 2, 3, 4], -1)).toEqual([null, null, null, null]);
    expect(finiteOrNull(rsi([1, 2, 3, 4], 5))).toBe(true);
  });

  it('is bounded 0..100 and deterministic', () => {
    const values = [10, 12, 11, 15, 14, 9, 8, 12, 13, 11, 10, 14, 16, 15, 13];
    const result = rsi(values, 5);
    for (const value of result) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(rsi(values, 5)).toEqual(rsi(values, 5));
  });
});

/** Independent Wilder RSI, written from scratch (no shared helpers). */
function independentWilderRsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;
  let gain = new Decimal(0);
  let loss = new Decimal(0);
  for (let i = 1; i <= period; i += 1) {
    const change = new Decimal(values[i] as number).minus(new Decimal(values[i - 1] as number));
    if (change.greaterThan(0)) gain = gain.plus(change);
    else loss = loss.plus(change.abs());
  }
  let avgGain = gain.div(period);
  let avgLoss = loss.div(period);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = new Decimal(values[i] as number).minus(new Decimal(values[i - 1] as number));
    const up = change.greaterThan(0) ? change : new Decimal(0);
    const down = change.lessThan(0) ? change.abs() : new Decimal(0);
    avgGain = avgGain.times(period - 1).plus(up).div(period);
    avgLoss = avgLoss.times(period - 1).plus(down).div(period);
  }
  if (avgLoss.isZero() && avgGain.isZero()) return null;
  if (avgLoss.isZero()) return 100;
  const rs = avgGain.div(avgLoss);
  return D(100).minus(D(100).div(D(1).plus(rs))).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
}

describe('indicator epsilon discipline', () => {
  it('documents why these two suites may use a tolerance while the money suites may not', () => {
    // ema/rsi return `number` by contract (indicator space, not ledger space).
    // Ledger assertions (tests/equity.test.ts) compare exact cent strings.
    expect(EPS).toBeLessThan(0.01);
  });
});
