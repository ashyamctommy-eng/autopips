import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * LIVE CANDLE BUILDING — fold a streamed broker tick into a candle series.
 *
 * The chart is seeded with historical candles from the broker (`GET
 * /api/v1/market/candles`) and then has to stay current between REST calls. This
 * module does that from `price:tick` events, and it is deliberately a set of
 * pure functions with no React, no socket and no clock of its own — the thing
 * that decides what a price bar looks like must be testable in isolation.
 *
 * ZERO FABRICATION RULES (this is a money platform; a chart is a claim):
 *   • A tick with no usable price, or no usable time, changes NOTHING. The
 *     series is returned by identity so React does not even re-render.
 *   • A tick older than the newest bar (out-of-order delivery, a replay, a
 *     reconnect) never rewrites history: buckets move forward only.
 *   • Volume is never invented. Ticks carry no traded size, so a bar built from
 *     ticks has no `volume` field at all, and an updated bar keeps whatever
 *     volume the broker reported for it — it is not incremented by "1 trade".
 *   • Only the current bucket's high/low/close move. `open` is the first price
 *     this module saw for that bucket, and it is never back-filled from a
 *     previous bar's close.
 */

/** A tick as it arrives on `price:tick` (see `Quote` in broker.types.ts). */
export interface LiveTick {
  bid?: number | null;
  ask?: number | null;
  /** Broker quote time: epoch seconds, epoch milliseconds, or an ISO string. */
  time?: number | string | null;
}

/**
 * Bucket size per timeframe.
 *
 * Exactly the timeframes the candles route accepts: if the API cannot serve a
 * timeframe, building bars for it here would produce a series the server would
 * never agree with.
 */
const TIMEFRAME_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

/** Bucket size for a timeframe, or null when it is not one we support. */
export function timeframeSeconds(timeframe: string): number | null {
  return TIMEFRAME_SECONDS[timeframe] ?? null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The price a tick represents.
 *
 * Mid of bid/ask when both sides were reported; otherwise the single reported
 * side. Null when neither is usable — a tick with no price is not a datapoint.
 */
export function tickPrice(tick: LiveTick): number | null {
  const bid = isFiniteNumber(tick.bid) ? tick.bid : null;
  const ask = isFiniteNumber(tick.ask) ? tick.ask : null;
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask;
}

/**
 * The tick's time in UNIX SECONDS (what lightweight-charts and the broker
 * candles both use). Accepts seconds, milliseconds and ISO strings; returns null
 * for anything else rather than defaulting to "now", which would draw a bar at a
 * time the broker never quoted.
 */
export function tickTimeSeconds(tick: LiveTick): number | null {
  let value: number | null = null;

  if (isFiniteNumber(tick.time)) {
    // Anything past ~33658 AD in seconds is really milliseconds.
    value = tick.time > 1e12 ? Math.floor(tick.time / 1000) : Math.floor(tick.time);
  } else if (typeof tick.time === 'string' && tick.time.length > 0) {
    const parsed = Date.parse(tick.time);
    if (Number.isFinite(parsed)) value = Math.floor(parsed / 1000);
  }

  if (value === null || value <= 0) return null;
  return value;
}

/** Start of the bucket a moment belongs to. */
export function bucketStartSeconds(timeSeconds: number, intervalSeconds: number): number {
  return Math.floor(timeSeconds / intervalSeconds) * intervalSeconds;
}

/**
 * Fold one tick into the series.
 *
 * Returns the SAME array reference when the tick changed nothing, so a caller
 * can pass the result straight into React state without causing a re-render per
 * duplicate tick.
 */
export function mergeTickIntoSeries(
  candles: Candle[],
  tick: LiveTick,
  timeframe: string,
): Candle[] {
  const interval = timeframeSeconds(timeframe);
  if (interval === null) return candles;

  const price = tickPrice(tick);
  const time = tickTimeSeconds(tick);
  if (price === null || time === null) return candles;

  const bucket = bucketStartSeconds(time, interval);

  if (candles.length === 0) {
    return [{ time: bucket, open: price, high: price, low: price, close: price }];
  }

  const last = candles[candles.length - 1];

  // Out-of-order or already-closed bucket: ignored, never merged backwards.
  if (bucket < last.time) return candles;

  if (bucket === last.time) {
    const high = Math.max(last.high, price);
    const low = Math.min(last.low, price);
    if (high === last.high && low === last.low && price === last.close) return candles;

    const updated: Candle = { ...last, high, low, close: price };
    return [...candles.slice(0, -1), updated];
  }

  // A new bucket: `open` is this tick, and there is deliberately no `volume`.
  return [
    ...candles,
    { time: bucket, open: price, high: price, low: price, close: price },
  ];
}

/**
 * Fold a batch of ticks (ascending by time) into the series.
 *
 * Used when the chart re-renders with a tick it has not seen yet; each tick goes
 * through exactly the same rules as `mergeTickIntoSeries`.
 */
export function mergeTicksIntoSeries(
  candles: Candle[],
  ticks: LiveTick[],
  timeframe: string,
): Candle[] {
  let next = candles;
  for (const tick of ticks) next = mergeTickIntoSeries(next, tick, timeframe);
  return next;
}
