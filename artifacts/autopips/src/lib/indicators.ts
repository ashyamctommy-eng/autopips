import type { Candle } from '@/types/broker.types';

/**
 * INDICATOR MATH (client-side).
 *
 * Pure functions over the candle series the chart already has. They exist so the
 * toolbar's indicators are REAL — computed from the same bars that are drawn —
 * rather than a dropdown that changes nothing.
 *
 * Every series is returned aligned to its input by time, and a value that cannot
 * be computed (not enough bars) is simply omitted rather than guessed: a moving
 * average of the first 19 bars does not exist, so nothing is drawn for them.
 */

export type IndicatorId = 'ma' | 'rsi' | 'macd' | 'bb';

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface IndicatorLine {
  id: string;
  label: string;
  color: string;
  /** `line` draws on the price pane; `histogram`/`paneLine` belong to a sub-pane. */
  kind: 'overlay' | 'paneLine' | 'histogram';
  data: IndicatorPoint[];
}

/** Simple moving average. */
export function sma(candles: readonly Candle[], period: number): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i]!.close;
    if (i >= period) sum -= candles[i - period]!.close;
    if (i >= period - 1) out.push({ time: candles[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` closes. */
export function ema(candles: readonly Candle[], period: number): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];
  const k = 2 / (period + 1);
  const out: IndicatorPoint[] = [];
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += candles[i]!.close;
  let previous = seed / period;
  out.push({ time: candles[period - 1]!.time, value: previous });
  for (let i = period; i < candles.length; i += 1) {
    previous = candles[i]!.close * k + previous * (1 - k);
    out.push({ time: candles[i]!.time, value: previous });
  }
  return out;
}

/** Bollinger Bands: middle SMA plus ±`deviations` population standard deviations. */
export function bollinger(
  candles: readonly Candle[],
  period = 20,
  deviations = 2,
): { middle: IndicatorPoint[]; upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
  if (period < 2 || candles.length < period) return { middle: [], upper: [], lower: [] };
  const middle: IndicatorPoint[] = [];
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const mean = window.reduce((acc, c) => acc + c.close, 0) / period;
    const variance = window.reduce((acc, c) => acc + (c.close - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const time = candles[i]!.time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + deviations * sd });
    lower.push({ time, value: mean - deviations * sd });
  }
  return { middle, upper, lower };
}

/** Wilder's RSI. */
export function rsi(candles: readonly Candle[], period = 14): IndicatorPoint[] {
  if (candles.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: IndicatorPoint[] = [];
  const value = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out.push({ time: candles[period]!.time, value: value(avgGain, avgLoss) });
  for (let i = period + 1; i < candles.length; i += 1) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out.push({ time: candles[i]!.time, value: value(avgGain, avgLoss) });
  }
  return out;
}

/** MACD: fast/slow EMAs, the signal EMA of the spread, and their difference. */
export function macd(
  candles: readonly Candle[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { line: IndicatorPoint[]; signal: IndicatorPoint[]; histogram: IndicatorPoint[] } {
  const fastSeries = ema(candles, fast);
  const slowSeries = ema(candles, slow);
  if (fastSeries.length === 0 || slowSeries.length === 0) return { line: [], signal: [], histogram: [] };

  const slowByTime = new Map(slowSeries.map((point) => [point.time, point.value]));
  const line: IndicatorPoint[] = [];
  for (const point of fastSeries) {
    const slowValue = slowByTime.get(point.time);
    if (slowValue === undefined) continue;
    line.push({ time: point.time, value: point.value - slowValue });
  }
  if (line.length === 0) return { line: [], signal: [], histogram: [] };

  // Signal = EMA of the MACD line, seeded the same way (SMA of the first period).
  const signal: IndicatorPoint[] = [];
  if (line.length >= signalPeriod) {
    const k = 2 / (signalPeriod + 1);
    let seed = 0;
    for (let i = 0; i < signalPeriod; i += 1) seed += line[i]!.value;
    let previous = seed / signalPeriod;
    signal.push({ time: line[signalPeriod - 1]!.time, value: previous });
    for (let i = signalPeriod; i < line.length; i += 1) {
      previous = line[i]!.value * k + previous * (1 - k);
      signal.push({ time: line[i]!.time, value: previous });
    }
  }

  const signalByTime = new Map(signal.map((point) => [point.time, point.value]));
  const histogram: IndicatorPoint[] = line
    .filter((point) => signalByTime.has(point.time))
    .map((point) => ({ time: point.time, value: point.value - signalByTime.get(point.time)! }));

  return { line, signal, histogram };
}

export interface ComputedIndicators {
  /** Lines drawn on the price pane. */
  overlays: IndicatorLine[];
  /** Lines/histograms drawn in the sub-pane, in draw order. */
  pane: IndicatorLine[];
}

const COLOURS = {
  ma20: '#38bdf8',
  ma50: '#f59e0b',
  bbUpper: '#a78bfa',
  bbLower: '#a78bfa',
  rsi: '#22d3ee',
  macd: '#38bdf8',
  macdSignal: '#f59e0b',
  macdHistogram: '#94a3b8',
};

/** Compute every enabled indicator for the loaded candles. */
export function computeIndicators(candles: readonly Candle[], enabled: readonly IndicatorId[]): ComputedIndicators {
  const overlays: IndicatorLine[] = [];
  const pane: IndicatorLine[] = [];

  if (enabled.includes('ma')) {
    overlays.push({ id: 'ma20', label: 'MA 20', color: COLOURS.ma20, kind: 'overlay', data: sma(candles, 20) });
    overlays.push({ id: 'ma50', label: 'MA 50', color: COLOURS.ma50, kind: 'overlay', data: sma(candles, 50) });
  }
  if (enabled.includes('bb')) {
    const bands = bollinger(candles, 20, 2);
    overlays.push({ id: 'bbUpper', label: 'BB upper', color: COLOURS.bbUpper, kind: 'overlay', data: bands.upper });
    overlays.push({ id: 'bbLower', label: 'BB lower', color: COLOURS.bbLower, kind: 'overlay', data: bands.lower });
  }
  if (enabled.includes('rsi')) {
    pane.push({ id: 'rsi', label: 'RSI 14', color: COLOURS.rsi, kind: 'paneLine', data: rsi(candles, 14) });
  }
  if (enabled.includes('macd')) {
    const value = macd(candles);
    pane.push({ id: 'macdHistogram', label: 'MACD histogram', color: COLOURS.macdHistogram, kind: 'histogram', data: value.histogram });
    pane.push({ id: 'macd', label: 'MACD', color: COLOURS.macd, kind: 'paneLine', data: value.line });
    pane.push({ id: 'macdSignal', label: 'Signal', color: COLOURS.macdSignal, kind: 'paneLine', data: value.signal });
  }

  return { overlays, pane };
}
