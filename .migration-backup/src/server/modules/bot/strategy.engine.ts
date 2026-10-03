/**
 * Deterministic strategy engine.
 *
 * DATA SOURCE: only historical candles fetched from the broker
 * (`BrokerAdapter.getHistoricalCandles`). There is no randomness, no hardcoded
 * signal list and no "default to BUY": the same candle series always yields the
 * same signal (or none). Nothing in this file reads the clock, the balance or the
 * position book, so a signal can be replayed exactly.
 *
 * RULE — EMA(fast)/EMA(slow) crossover confirmed by RSI bounds, evaluated on the
 * last candle the bridge returned (the signal bar):
 *
 *   BUY   when  EMAfast[i-1] <= EMAslow[i-1]  AND  EMAfast[i] > EMAslow[i]
 *         and   RSI[i] < rsiOverbought          (the move is not already extended)
 *   SELL  when  EMAfast[i-1] >= EMAslow[i-1]  AND  EMAfast[i] < EMAslow[i]
 *         and   RSI[i] > rsiOversold            (the move is not already exhausted)
 *   otherwise → null (no trade)
 *
 * Protective levels are derived from the same candle series, never from a
 * constant: the stop is the extreme of the last `stopLookback` candles and the
 * target is `rewardRisk` × the distance to that stop. If those levels cannot be
 * derived from real candles they are omitted from the signal.
 *
 * Indicators (`ema`, `rsi`) are exported as pure functions, Decimal-backed, so
 * the rules can be unit-tested without a broker.
 */

import { createHash } from 'node:crypto';
import { D, Decimal } from '@/lib/money';
import type { BrokerAdapter, Candle } from '../broker/broker.types';
import type { TradeSignal } from './bot.types';

/** Documented rule text — surfaced in strategy config/UI and audit details. */
export const STRATEGY_RULE =
  'BUY/SELL on EMA(fast) crossing EMA(slow) on the last broker candle, confirmed by RSI(period) staying inside [oversold, overbought]; no cross or an RSI outside the bounds yields no signal.';

export interface StrategyConfig {
  /** Strategy identifier, e.g. "gold-momentum". */
  strategy: string;
  /** EMA fast period (must be >= 2 and < slowPeriod). */
  fastPeriod: number;
  /** EMA slow period. */
  slowPeriod: number;
  /** RSI period. */
  rsiPeriod: number;
  /** Upper RSI guard: a BUY is refused at or above this level. */
  rsiOverbought: number;
  /** Lower RSI guard: a SELL is refused at or below this level. */
  rsiOversold: number;
  /** Candles to request from the bridge (must exceed slowPeriod + 2). */
  candleCount: number;
  /** Master-account lot size this strategy trades with (operational config). */
  masterVolume: number;
  /** Candles used to derive the protective stop (default 10). */
  stopLookback?: number;
  /** Target = rewardRisk × stop distance (default 2). */
  rewardRisk?: number;
}

export interface EvaluateStrategyInput {
  adapter: BrokerAdapter;
  symbol: string;
  timeframe: string;
  config: StrategyConfig;
}

/** EMA series, aligned with `values`. Seeded with the SMA of the first period. */
export function ema(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;

  const multiplier = D(2).div(period + 1);
  let sum = D(0);
  for (let i = 0; i < period; i += 1) sum = sum.plus(D(values[i]!));
  let previous = sum.div(period);
  out[period - 1] = previous.toNumber();

  for (let i = period; i < values.length; i += 1) {
    const value = D(values[i]!);
    previous = value.minus(previous).times(multiplier).plus(previous);
    out[i] = previous.toNumber();
  }
  return out;
}

/** Wilder's RSI series, aligned with `values` (null until `period + 1` values). */
export function rsi(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period + 1) return out;

  let gainSum = D(0);
  let lossSum = D(0);
  for (let i = 1; i <= period; i += 1) {
    const change = D(values[i]!).minus(D(values[i - 1]!));
    if (change.greaterThan(0)) gainSum = gainSum.plus(change);
    else lossSum = lossSum.plus(change.abs());
  }
  let avgGain = gainSum.div(period);
  let avgLoss = lossSum.div(period);
  out[period] = computeRsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = D(values[i]!).minus(D(values[i - 1]!));
    const gain = change.greaterThan(0) ? change : D(0);
    const loss = change.lessThan(0) ? change.abs() : D(0);
    avgGain = avgGain.times(period - 1).plus(gain).div(period);
    avgLoss = avgLoss.times(period - 1).plus(loss).div(period);
    out[i] = computeRsiValue(avgGain, avgLoss);
  }
  return out;
}

function computeRsiValue(avgGain: Decimal, avgLoss: Decimal): number | null {
  if (avgLoss.isZero() && avgGain.isZero()) return null; // flat series: no honest RSI
  if (avgLoss.isZero()) return 100;
  const rs = avgGain.div(avgLoss);
  return D(100).minus(D(100).div(D(1).plus(rs))).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
}

function sanitizeSegment(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'strategy';
}

/**
 * Deterministic signal id: the same setup on the same bar always produces the
 * same id, which is what makes the order layer idempotent across replicas and
 * retries. Derived from broker candle data only.
 */
export function buildSignalId(args: {
  strategy: string;
  symbol: string;
  timeframe: string;
  direction: 'BUY' | 'SELL';
  barTime: number;
}): string {
  const hash = createHash('sha256')
    .update(`${args.strategy}|${args.symbol}|${args.timeframe}|${args.direction}|${args.barTime}`)
    .digest('hex')
    .slice(0, 16);
  return `${sanitizeSegment(args.strategy)}-${hash}`;
}

function isUsableConfig(config: StrategyConfig): boolean {
  return (
    Number.isFinite(config.fastPeriod) &&
    Number.isFinite(config.slowPeriod) &&
    Number.isFinite(config.rsiPeriod) &&
    config.fastPeriod >= 2 &&
    config.slowPeriod > config.fastPeriod &&
    config.rsiPeriod >= 2 &&
    Number.isFinite(config.rsiOverbought) &&
    Number.isFinite(config.rsiOversold) &&
    config.rsiOverbought > config.rsiOversold &&
    Number.isFinite(config.masterVolume) &&
    config.masterVolume > 0 &&
    Number.isFinite(config.candleCount) &&
    config.candleCount > config.slowPeriod + 2
  );
}

/**
 * Evaluates the rule against broker candles. Returns `TradeSignal | null` —
 * never throws for empty/short/odd candle data, it simply declines to signal.
 */
export async function evaluateStrategy(input: EvaluateStrategyInput): Promise<TradeSignal | null> {
  const { adapter, symbol, timeframe, config } = input;
  if (!isUsableConfig(config)) return null;

  const candles: Candle[] = await adapter.getHistoricalCandles(symbol, timeframe, Math.trunc(config.candleCount));
  if (candles.length < config.slowPeriod + 2) return null;

  const closes = candles.map((candle) => candle.close);
  if (closes.some((close) => !Number.isFinite(close))) return null;

  const fast = ema(closes, config.fastPeriod);
  const slow = ema(closes, config.slowPeriod);
  const momentum = rsi(closes, config.rsiPeriod);

  const index = candles.length - 1;
  const previous = index - 1;
  const fastNow = fast[index];
  const fastPrev = fast[previous];
  const slowNow = slow[index];
  const slowPrev = slow[previous];
  const rsiNow = momentum[index];

  if (
    fastNow === null ||
    fastPrev === null ||
    slowNow === null ||
    slowPrev === null ||
    rsiNow === null ||
    !Number.isFinite(fastNow) ||
    !Number.isFinite(fastPrev) ||
    !Number.isFinite(slowNow) ||
    !Number.isFinite(slowPrev) ||
    !Number.isFinite(rsiNow)
  ) {
    return null;
  }

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;

  let direction: 'BUY' | 'SELL' | null = null;
  if (crossedUp && rsiNow < config.rsiOverbought) direction = 'BUY';
  else if (crossedDown && rsiNow > config.rsiOversold) direction = 'SELL';
  if (!direction) return null;

  const bar = candles[index]!;
  const stopLookback = Math.max(2, Math.trunc(config.stopLookback ?? 10));
  const window = candles.slice(Math.max(0, candles.length - stopLookback));
  const rewardRisk = D(config.rewardRisk ?? 2);
  const entry = D(bar.close);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;

  if (direction === 'BUY') {
    const low = window.reduce<Decimal>((acc, candle) => (D(candle.low).lessThan(acc) ? D(candle.low) : acc), D(window[0]!.low));
    if (low.lessThan(entry)) {
      stopLoss = low.toDecimalPlaces(5, Decimal.ROUND_HALF_UP).toNumber();
      takeProfit = entry.plus(entry.minus(low).times(rewardRisk)).toDecimalPlaces(5, Decimal.ROUND_HALF_UP).toNumber();
    }
  } else {
    const high = window.reduce<Decimal>(
      (acc, candle) => (D(candle.high).greaterThan(acc) ? D(candle.high) : acc),
      D(window[0]!.high),
    );
    if (high.greaterThan(entry)) {
      stopLoss = high.toDecimalPlaces(5, Decimal.ROUND_HALF_UP).toNumber();
      takeProfit = entry.minus(high.minus(entry).times(rewardRisk)).toDecimalPlaces(5, Decimal.ROUND_HALF_UP).toNumber();
    }
  }

  const reason =
    `${direction === 'BUY' ? 'EMA fast crossed above slow' : 'EMA fast crossed below slow'}` +
    ` (${config.fastPeriod}/${config.slowPeriod}) on ${symbol} ${timeframe} close ${entry.toString()};` +
    ` RSI(${config.rsiPeriod}) = ${rsiNow.toFixed(2)} within [${config.rsiOversold}, ${config.rsiOverbought}] bounds.`;

  return {
    signalId: buildSignalId({
      strategy: config.strategy,
      symbol,
      timeframe,
      direction,
      barTime: bar.time,
    }),
    symbol,
    direction,
    masterVolume: config.masterVolume,
    ...(stopLoss !== undefined ? { stopLoss } : {}),
    ...(takeProfit !== undefined ? { takeProfit } : {}),
    reason,
    strategy: config.strategy,
    brokerAccountId: adapter.accountId,
    // The bar that produced the signal — deterministic, not wall-clock time.
    createdAt: new Date(bar.time * 1000),
  };
}
