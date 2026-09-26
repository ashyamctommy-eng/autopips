import { describe, expect, it } from 'vitest';

import {
  computePositionPnl,
  isProtectivePairSane,
  positionExitTrigger,
} from '@/server/modules/positions/position.math';
import { buildEquityFromAggregates } from '@/server/accounting/ledger';

/**
 * Internal position economics (`EXECUTION_MODE=internal`).
 *
 * The two properties that matter to a client's money:
 *   1. P&L follows the documented model and is CLAMPED at −stake — a client can
 *      never lose more than they put at risk, however far the market moves.
 *   2. Positions are the same money as everything else: the stake is DEPLOYED
 *      capital and the pnl is a P/L term, so opening is equity-neutral and the
 *      ledger identity still holds. There is no second balance anywhere.
 */

describe('computePositionPnl', () => {
  it('marks a BUY up and down proportionally to the notional', () => {
    expect(computePositionPnl({ side: 'BUY', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 110 }).toFixed(2)).toBe('10.00');
    expect(computePositionPnl({ side: 'BUY', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 90 }).toFixed(2)).toBe('-10.00');
  });

  it('applies the multiplier to the exposure', () => {
    // stake 100, x10 → notional 1000; a 1% move is $10.
    expect(computePositionPnl({ side: 'BUY', stake: 100, multiplier: 10, entryPrice: 100, currentPrice: 101 }).toFixed(2)).toBe('10.00');
  });

  it('mirrors the sign for a SELL', () => {
    expect(computePositionPnl({ side: 'SELL', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 110 }).toFixed(2)).toBe('-10.00');
    expect(computePositionPnl({ side: 'SELL', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 80 }).toFixed(2)).toBe('20.00');
  });

  it('CLAMPS the loss at the stake — the client can never owe more than they risked', () => {
    // A BUY halving against x10 leverage would be -500 unclamped.
    expect(computePositionPnl({ side: 'BUY', stake: 100, multiplier: 10, entryPrice: 100, currentPrice: 50 }).toFixed(2)).toBe('-100.00');
    // A SELL into a 10x move would be -900 unclamped.
    expect(computePositionPnl({ side: 'SELL', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 1000 }).toFixed(2)).toBe('-100.00');
  });

  it('does not clamp the upside', () => {
    expect(computePositionPnl({ side: 'BUY', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: 250 }).toFixed(2)).toBe('150.00');
  });

  it('refuses structurally invalid inputs instead of returning zero', () => {
    expect(() => computePositionPnl({ side: 'BUY', stake: -1, multiplier: 1, entryPrice: 100, currentPrice: 100 })).toThrow();
    expect(() => computePositionPnl({ side: 'BUY', stake: 100, multiplier: 0, entryPrice: 100, currentPrice: 100 })).toThrow();
    expect(() => computePositionPnl({ side: 'BUY', stake: 100, multiplier: 1, entryPrice: 0, currentPrice: 100 })).toThrow();
    expect(() => computePositionPnl({ side: 'BUY', stake: 100, multiplier: 1, entryPrice: 100, currentPrice: Number.NaN })).toThrow();
  });
});

describe('positionExitTrigger', () => {
  it('fires a BUY stop-loss at or below the level and a take-profit at or above', () => {
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 95, takeProfit: 110, price: 94 })).toBe('STOP_LOSS');
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 95, takeProfit: 110, price: 95 })).toBe('STOP_LOSS');
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 95, takeProfit: 110, price: 111 })).toBe('TAKE_PROFIT');
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 95, takeProfit: 110, price: 100 })).toBeNull();
  });

  it('inverts the levels for a SELL', () => {
    expect(positionExitTrigger({ side: 'SELL', stopLoss: 105, takeProfit: 90, price: 106 })).toBe('STOP_LOSS');
    expect(positionExitTrigger({ side: 'SELL', stopLoss: 105, takeProfit: 90, price: 89 })).toBe('TAKE_PROFIT');
    expect(positionExitTrigger({ side: 'SELL', stopLoss: 105, takeProfit: 90, price: 100 })).toBeNull();
  });

  it('fires the stop when a gap blows straight through it', () => {
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 95, takeProfit: 110, price: 50 })).toBe('STOP_LOSS');
  });

  it('prefers the STOP_LOSS when both levels sit on the checked price (defensive ordering)', () => {
    // A sane pair can never cross both at once; this pins the tie-break for a
    // malformed/legacy row so a loss is never booked as a win.
    expect(positionExitTrigger({ side: 'BUY', stopLoss: 100, takeProfit: 100, price: 100 })).toBe('STOP_LOSS');
  });

  it('never fires without a level', () => {
    expect(positionExitTrigger({ side: 'BUY', stopLoss: null, takeProfit: null, price: 1 })).toBeNull();
  });
});

describe('isProtectivePairSane', () => {
  it('accepts a correctly-sided pair', () => {
    expect(isProtectivePairSane({ side: 'BUY', entryPrice: 100, stopLoss: 95, takeProfit: 110 })).toBe(true);
    expect(isProtectivePairSane({ side: 'SELL', entryPrice: 100, stopLoss: 105, takeProfit: 90 })).toBe(true);
  });

  it('rejects a crossed pair, which would fire immediately at an unintended loss', () => {
    expect(isProtectivePairSane({ side: 'BUY', entryPrice: 100, stopLoss: 105, takeProfit: 110 })).toBe(false);
    expect(isProtectivePairSane({ side: 'BUY', entryPrice: 100, stopLoss: 95, takeProfit: 90 })).toBe(false);
    expect(isProtectivePairSane({ side: 'SELL', entryPrice: 100, stopLoss: 95, takeProfit: 90 })).toBe(false);
  });

  it('allows omitting either level', () => {
    expect(isProtectivePairSane({ side: 'BUY', entryPrice: 100 })).toBe(true);
    expect(isProtectivePairSane({ side: 'BUY', entryPrice: 100, stopLoss: 95 })).toBe(true);
  });
});

describe('positions in the single equity formula', () => {
  it('opening a position is EQUITY-NEUTRAL (stake moves from idle cash to deployed)', () => {
    const before = buildEquityFromAggregates({
      creditedDeposits: 1000,
      paidWithdrawals: 0,
      deployedCapital: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      deductedFees: 0,
    });
    const after = buildEquityFromAggregates({
      creditedDeposits: 1000,
      paidWithdrawals: 0,
      // The position's stake now counts as deployed capital.
      deployedCapital: 300,
      realizedPnL: 0,
      unrealizedPnL: 0,
      deductedFees: 0,
    });

    expect(before.equity.toFixed(2)).toBe('1000.00');
    expect(after.equity.toFixed(2)).toBe('1000.00');
    // The two capital terms remain a partition of credited deposits.
    expect(after.startingCapital.plus(after.confirmedDeposits).toFixed(2)).toBe('1000.00');
  });

  it('an OPEN position marks equity by its unrealized pnl only', () => {
    const { equity, netContributedCapital } = buildEquityFromAggregates({
      creditedDeposits: 1000,
      paidWithdrawals: 0,
      deployedCapital: 300,
      realizedPnL: 0,
      unrealizedPnL: 7.5,
      deductedFees: 0,
    });

    expect(netContributedCapital.toFixed(2)).toBe('1000.00');
    expect(equity.toFixed(2)).toBe('1007.50');
  });

  it('a CLOSED position realizes its pnl and releases the stake (identity holds)', () => {
    // stake 300 closed at +20 realized: no longer deployed, pnl is realized.
    const { equity, netContributedCapital, realizedPnL, startingCapital } = buildEquityFromAggregates({
      creditedDeposits: 1000,
      paidWithdrawals: 0,
      deployedCapital: 0,
      realizedPnL: 20,
      unrealizedPnL: 0,
      deductedFees: 0,
    });

    expect(startingCapital.toFixed(2)).toBe('0.00');
    expect(realizedPnL.toFixed(2)).toBe('20.00');
    expect(netContributedCapital.toFixed(2)).toBe('1000.00');
    expect(equity.toFixed(2)).toBe('1020.00');
    // Identity: netContributed + realized + unrealized − fees === equity
    expect(netContributedCapital.plus(realizedPnL).toFixed(2)).toBe(equity.toFixed(2));
  });

  it('a losing position cannot drive equity below what the clamp allows', () => {
    // stake 100, clamped loss -100 → equity 900 on 1000 credited.
    const { equity } = buildEquityFromAggregates({
      creditedDeposits: 1000,
      paidWithdrawals: 0,
      deployedCapital: 100,
      realizedPnL: 0,
      unrealizedPnL: -100,
      deductedFees: 0,
    });
    expect(equity.toFixed(2)).toBe('900.00');
  });
});
