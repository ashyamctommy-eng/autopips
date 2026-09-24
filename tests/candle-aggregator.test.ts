import { describe, expect, it } from 'vitest';
import {
  bucketStartSeconds,
  mergeTickIntoSeries,
  mergeTicksIntoSeries,
  tickPrice,
  tickTimeSeconds,
  timeframeSeconds,
} from '@/lib/candle-aggregator';
import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * LIVE CANDLE BUILDING — the ratchet behind the chart's realtime bars.
 *
 * Everything the chart draws between REST refreshes comes out of these
 * functions, so the properties pinned here are the ones a broker screen must
 * never violate: no bar without a real price, no rewritten history, no invented
 * volume, and no re-render churn from a duplicate tick.
 */

const HOUR = 3_600;

function series(...candles: Candle[]): Candle[] {
  return candles;
}

/** 2026-09-24T12:00:00Z, on an exact hour boundary. */
const T12 = 1790251200;

describe('timeframes', () => {
  it('maps exactly the timeframes the candles API serves', () => {
    expect(timeframeSeconds('1m')).toBe(60);
    expect(timeframeSeconds('5m')).toBe(300);
    expect(timeframeSeconds('1h')).toBe(HOUR);
    expect(timeframeSeconds('1d')).toBe(86_400);
  });

  it('refuses a timeframe it cannot bucket', () => {
    expect(timeframeSeconds('3m')).toBeNull();
    expect(timeframeSeconds('')).toBeNull();
  });
});

describe('tick extraction', () => {
  it('uses the mid when both sides were quoted', () => {
    expect(tickPrice({ bid: 1999.5, ask: 2000.5 })).toBe(2000);
  });

  it('uses the single reported side rather than inventing the other', () => {
    expect(tickPrice({ bid: 1999.5 })).toBe(1999.5);
    expect(tickPrice({ ask: 2000.5 })).toBe(2000.5);
  });

  it('returns null for a tick with no usable price', () => {
    expect(tickPrice({})).toBeNull();
    expect(tickPrice({ bid: Number.NaN, ask: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('reads seconds, milliseconds and ISO times as seconds', () => {
    expect(tickTimeSeconds({ time: T12 })).toBe(T12);
    expect(tickTimeSeconds({ time: T12 * 1000 })).toBe(T12);
    expect(tickTimeSeconds({ time: '2026-09-24T12:00:00Z' })).toBe(T12);
  });

  it('returns null instead of defaulting a missing or unusable time to "now"', () => {
    expect(tickTimeSeconds({})).toBeNull();
    expect(tickTimeSeconds({ time: 0 })).toBeNull();
    expect(tickTimeSeconds({ time: -5 })).toBeNull();
    expect(tickTimeSeconds({ time: 'not a date' })).toBeNull();
  });

  it('floors a moment into its bucket', () => {
    expect(bucketStartSeconds(T12 + 59, 60)).toBe(T12);
    expect(bucketStartSeconds(T12 + 60, 60)).toBe(T12 + 60);
    expect(bucketStartSeconds(T12 + 3_599, HOUR)).toBe(T12);
  });
});

describe('folding a tick into the series', () => {
  const openBar: Candle[] = series({ time: T12, open: 1990, high: 2000, low: 1985, close: 1995 });

  it('starts a series from a tick when there is no history', () => {
    const next = mergeTickIntoSeries([], { bid: 1999, ask: 2001, time: T12 }, '1h');
    expect(next).toEqual([{ time: T12, open: 2000, high: 2000, low: 2000, close: 2000 }]);
    // No volume: ticks carry no traded size.
    expect('volume' in next[0]).toBe(false);
  });

  it('updates high/low/close in the current bucket and keeps open', () => {
    const raised = mergeTickIntoSeries(openBar, { bid: 2010, ask: 2012, time: T12 + 120 }, '1h');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toEqual({ time: T12, open: 1990, high: 2011, low: 1985, close: 2011 });

    const lowered = mergeTickIntoSeries(raised, { bid: 1970, ask: 1972, time: T12 + 180 }, '1h');
    expect(lowered[0]).toEqual({ time: T12, open: 1990, high: 2011, low: 1971, close: 1971 });
  });

  it('preserves broker-reported volume and never adds to it', () => {
    const withVolume: Candle[] = series({
      time: T12,
      open: 1990,
      high: 2000,
      low: 1985,
      close: 1995,
      volume: 1_234,
    });
    const next = mergeTickIntoSeries(withVolume, { bid: 2005, ask: 2005, time: T12 + 30 }, '1h');
    expect(next[0].volume).toBe(1_234);
  });

  it('opens a new bucket from the tick price, never from the previous close', () => {
    const next = mergeTickIntoSeries(openBar, { bid: 2100, ask: 2101, time: T12 + HOUR + 5 }, '1h');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({
      time: T12 + HOUR,
      open: 2100.5,
      high: 2100.5,
      low: 2100.5,
      close: 2100.5,
    });
    expect('volume' in next[1]).toBe(false);
  });

  it('ignores a tick from a bucket that has already closed', () => {
    const next = mergeTickIntoSeries(openBar, { bid: 1999, ask: 1999, time: T12 - HOUR }, '1h');
    expect(next).toBe(openBar);
  });

  it('ignores an unusable tick and an unsupported timeframe by identity', () => {
    expect(mergeTickIntoSeries(openBar, { bid: 2000, ask: 2000 }, '1h')).toBe(openBar);
    expect(mergeTickIntoSeries(openBar, { time: T12 + 10 }, '1h')).toBe(openBar);
    expect(mergeTickIntoSeries(openBar, { bid: 2000, ask: 2000, time: T12 + 10 }, '3m')).toBe(openBar);
  });

  it('returns the identical array when a repeated tick changes nothing', () => {
    const once = mergeTickIntoSeries(openBar, { bid: 2005, ask: 2005, time: T12 + 60 }, '1h');
    const twice = mergeTickIntoSeries(once, { bid: 2005, ask: 2005, time: T12 + 61 }, '1h');
    expect(twice).toBe(once);
  });

  it('applies a batch in order, skipping the unusable ones', () => {
    const ticks = [
      { bid: 2001, ask: 2001, time: T12 + 10 },
      { bid: 2002, ask: 2002, time: T12 + 20 },
      { bid: Number.NaN, ask: Number.NaN, time: T12 + 30 },
      { bid: 1990, ask: 1990, time: T12 + HOUR + 1 },
    ];
    const next = mergeTicksIntoSeries(openBar, ticks, '1h');
    expect(next).toHaveLength(2);
    expect(next[0].close).toBe(2002);
    expect(next[1]).toMatchObject({ time: T12 + HOUR, open: 1990, close: 1990 });
  });
});
