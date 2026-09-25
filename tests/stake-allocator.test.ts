import { describe, expect, it } from 'vitest';

import { allocateStake, MIN_STAKE_USD } from '@/server/modules/bot/stake.allocator';

/**
 * THE EXPOSURE MODEL (settled 2026-09-25 — see HANDOVER.md §Exposure model)
 *
 * A Deriv multiplier contract is bought with a STAKE, and the stake is the
 * maximum loss the client can take on it. So risk is sized in dollars at risk,
 * three ceilings apply, and the notional (stake × multiplier) is DERIVED — never
 * the sizing target. These tests pin the clamps, the round-DOWN and every
 * refusal, because each of them is a way money could be put at risk beyond what
 * an operator authorised.
 */

const BASE = {
  capitalUsd: 10_000,
  currentValUsd: 10_000,
  maxDrawdownPct: 25,
  riskPerTradePct: 1,
  platformCapUsd: 0, // 0 = no operator ceiling
  multiplier: 100,
} as const;

describe('stake sizing', () => {
  it('risks the configured percentage of capital', () => {
    const result = allocateStake({ ...BASE });
    expect(result.skipped).toBe(false);
    expect(result.stake).toBe(100); // 1% of 10,000
    expect(result.notional).toBe(10_000); // 100 × 100
  });

  it('rounds DOWN to cents — a ceiling a fraction over is still a breach', () => {
    const result = allocateStake({ ...BASE, capitalUsd: 100.999 });
    // 1% = 1.00999 → 1.00, never 1.01
    expect(result.stake).toBe(1);
  });

  it('applies the operator ceiling when it is the tightest bound', () => {
    const result = allocateStake({ ...BASE, platformCapUsd: 25 });
    expect(result.stake).toBe(25);
    expect(result.bounds.platformCapUsd).toBe(25);
  });

  it('caps a single order by the plan’s remaining drawdown budget', () => {
    // 25% of 10,000 = 2,500 of drawdown allowed; 2,400 already taken → 100 left.
    const result = allocateStake({ ...BASE, currentValUsd: 7_600 });
    expect(result.bounds.drawdownBudgetUsd).toBe(100);
    expect(result.stake).toBe(100);
  });

  it('refuses when the drawdown budget is exhausted, even below the stop', () => {
    const result = allocateStake({ ...BASE, currentValUsd: 7_500 });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('DRAWDOWN_BUDGET_EXHAUSTED');
    expect(result.stake).toBeNull();
  });

  it('takes the SMALLEST of the three ceilings', () => {
    const result = allocateStake({
      ...BASE,
      capitalUsd: 10_000,
      currentValUsd: 7_550, // 2,450 of the 2,500 drawdown budget already taken → 50 left
      platformCapUsd: 75,
    });
    expect(result.stake).toBe(50);
  });
});

describe('refusals — every one of them is money NOT put at risk', () => {
  it('refuses without capital, and never invents one', () => {
    for (const capitalUsd of [null, 0, -100, Number.NaN]) {
      const result = allocateStake({ ...BASE, capitalUsd });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('NO_CAPITAL');
    }
  });

  it('treats a 0% risk setting as "nothing at risk", not as "use a default"', () => {
    const result = allocateStake({ ...BASE, riskPerTradePct: 0 });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('RISK_PER_TRADE_UNSET');
  });

  it('refuses without a multiplier — an unstated exposure cannot be reasoned about', () => {
    for (const multiplier of [0, -1, Number.NaN]) {
      const result = allocateStake({ ...BASE, multiplier });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('MULTIPLIER_UNSET');
    }
  });

  it('refuses a stake below the platform floor instead of rounding it up', () => {
    const result = allocateStake({ ...BASE, capitalUsd: 50 }); // 1% = 0.50
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('BELOW_MINIMUM_STAKE');
    expect(result.stake).toBeNull();
    expect(MIN_STAKE_USD).toBe(1);
  });

  it('carries the bounds it decided against, so an audit row can explain itself', () => {
    const result = allocateStake({ ...BASE, platformCapUsd: 25 });
    expect(result.bounds).toEqual({
      riskBudgetUsd: 100,
      drawdownBudgetUsd: 2_500,
      platformCapUsd: 25,
    });
  });
});

describe('the invariant the ledger depends on', () => {
  it('reports notional = stake × multiplier, so exposure never needs deriving from volume', () => {
    for (const multiplier of [10, 100, 250]) {
      const result = allocateStake({ ...BASE, multiplier });
      expect(result.notional).toBe(Number(((result.stake ?? 0) * multiplier).toFixed(2)));
    }
  });

  it('keeps the stake at or below every ceiling at once', () => {
    const result = allocateStake({
      ...BASE,
      capitalUsd: 3_333.33,
      currentValUsd: 3_200, // 133.33 of drawdown room at 25%
      riskPerTradePct: 2, // 66.67
      platformCapUsd: 500,
    });
    expect(result.stake).toBe(66.66); // round-down of 66.666…
    expect(result.stake!).toBeLessThanOrEqual(500);
    expect(result.stake!).toBeLessThanOrEqual(133.33);
  });
});
