import './helpers/test-env';

import { describe, expect, it } from 'vitest';

import { evaluateStrategy, STRATEGY_RULE_TEXTS } from '@/server/modules/bot/strategy.engine';
import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * The second entry rule (`rsi-reversion`).
 *
 * What must hold: it is a DIFFERENT rule, not a looser copy of the trend cross —
 * it fires on the turn out of an RSI extreme, and it declines when there is
 * nothing to reverse. These tests pin the trigger and the "no signal" case so the
 * engine cannot silently drift into firing on every bar (which would open
 * positions continuously).
 */

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * 300,
    open: close,
    high: close + 0.3,
    low: close - 0.3,
    close,
  }));
}

const adapterFor = (candles: Candle[]) => ({
  getHistoricalCandles: async () => candles,
});

const CONFIG = {
  strategy: 'fx-reversion',
  rule: 'rsi-reversion' as const,
  fastPeriod: 9,
  slowPeriod: 21,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  candleCount: 300,
  masterVolume: 0.1,
  stopLookback: 10,
  rewardRisk: 1.2,
};

/**
 * A steady decline drives RSI(14) to ~22 (oversold); the two-bar bounce lifts it
 * back to ~30.7 — the cross lands on the LAST bar, which is the bar the rule
 * evaluates. (The values were read off the engine's own `rsi()` rather than
 * guessed.)
 */
const DECLINE_THEN_BOUNCE = [
  ...Array.from({ length: 45 }, (_, i) => 100 - i * 0.4),
  83.9, 84.65,
];

/** The mirror: a steady advance drives RSI to ~84; two down bars roll it to ~66.5. */
const RALLY_THEN_FADE = [
  ...Array.from({ length: 45 }, (_, i) => 80 + i * 0.4),
  96.6, 95.1,
];

describe('rsi-reversion', () => {
  it('BUYs on the turn back up out of oversold, with protective levels from the candles', async () => {
    const signal = await evaluateStrategy({
      adapter: adapterFor(series(DECLINE_THEN_BOUNCE)),
      symbol: 'frxEURUSD',
      timeframe: '5m',
      config: CONFIG,
    });

    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe('BUY');
    expect(signal?.stopLoss).toBeLessThan(signal!.takeProfit!);
    expect(signal?.reason).toMatch(/oversold/i);
  });

  it('SELLs on the turn back down out of overbought', async () => {
    const signal = await evaluateStrategy({
      adapter: adapterFor(series(RALLY_THEN_FADE)),
      symbol: 'frxEURUSD',
      timeframe: '5m',
      config: CONFIG,
    });

    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe('SELL');
    expect(signal?.stopLoss).toBeGreaterThan(signal!.takeProfit!);
    expect(signal?.reason).toMatch(/overbought/i);
  });

  it('declines on a flat series — no extreme, no trade', async () => {
    const flat = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.01 : -0.01));
    const signal = await evaluateStrategy({
      adapter: adapterFor(series(flat)),
      symbol: 'frxEURUSD',
      timeframe: '5m',
      config: CONFIG,
    });
    expect(signal).toBeNull();
  });

  it('is a distinct rule: the trend cross does not fire on the same series', async () => {
    const signal = await evaluateStrategy({
      adapter: adapterFor(series(DECLINE_THEN_BOUNCE)),
      symbol: 'frxEURUSD',
      timeframe: '5m',
      config: { ...CONFIG, rule: 'ema-rsi' },
    });
    // A pure decline-then-bounce does not produce a *confirmed* EMA cross with the
    // RSI guard satisfied, which is exactly why the second rule exists.
    expect(signal).toBeNull();
  });

  it('documents both rules', () => {
    expect(STRATEGY_RULE_TEXTS['ema-rsi']).toMatch(/EMA/);
    expect(STRATEGY_RULE_TEXTS['rsi-reversion']).toMatch(/RSI/);
  });
});
