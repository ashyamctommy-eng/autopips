import { describe, expect, it } from 'vitest';

import {
  buildTwelveDataTimeSeriesUrl,
  getTwelveDataCandles,
  mapTwelveDataCandles,
  marketDataProvider,
  parseTwelveDataTimestamp,
  twelveDataInterval,
  twelveDataSymbol,
} from '@/server/modules/market/twelve-data.service';

/**
 * The Twelve Data feed is an ALTERNATIVE candle source behind
 * `MARKET_DATA_PROVIDER`. Two properties matter for money-adjacent code:
 *
 *   1. it must never GUESS a symbol — an unmapped instrument fails loudly rather
 *      than silently pricing the wrong one;
 *   2. it must never repair a bar — an unusable row is dropped and counted, and a
 *      failed request throws (the route turns that into an empty series).
 *
 * All of this is pure + injectable, so it is tested without a network or the key.
 */

describe('symbol + interval mapping', () => {
  it('maps the supported instruments explicitly', () => {
    expect(twelveDataSymbol('frxXAUUSD')).toBe('XAU/USD');
    expect(twelveDataSymbol('frxEURUSD')).toBe('EUR/USD');
    expect(twelveDataSymbol('cryBTCUSD')).toBe('BTC/USD');
  });

  it('refuses Deriv synthetics instead of inventing a proxy', () => {
    // R_10 / R_100 are broker-proprietary; no external vendor carries them.
    expect(twelveDataSymbol('R_10')).toBeNull();
    expect(twelveDataSymbol('R_100')).toBeNull();
    expect(twelveDataSymbol('nonsense')).toBeNull();
  });

  it('maps timeframes and rejects unsupported ones', () => {
    expect(twelveDataInterval('1m')).toBe('1min');
    expect(twelveDataInterval('1h')).toBe('1h');
    expect(twelveDataInterval('1d')).toBe('1day');
    expect(twelveDataInterval('2h')).toBeNull();
  });

  it('defaults the provider to deriv so nothing changes silently', () => {
    const original = process.env.MARKET_DATA_PROVIDER;
    delete process.env.MARKET_DATA_PROVIDER;
    expect(marketDataProvider()).toBe('deriv');
    process.env.MARKET_DATA_PROVIDER = 'twelve';
    expect(marketDataProvider()).toBe('twelve');
    process.env.MARKET_DATA_PROVIDER = 'something-else';
    expect(marketDataProvider()).toBe('deriv');
    if (original === undefined) delete process.env.MARKET_DATA_PROVIDER;
    else process.env.MARKET_DATA_PROVIDER = original;
  });
});

describe('parseTwelveDataTimestamp', () => {
  it('treats a bare datetime as UTC (the request asks for timezone=UTC)', () => {
    expect(parseTwelveDataTimestamp('2026-09-26 12:00:00')).toBe(
      Math.floor(Date.UTC(2026, 8, 26, 12, 0, 0) / 1000),
    );
    expect(parseTwelveDataTimestamp('2026-09-26')).toBe(
      Math.floor(Date.UTC(2026, 8, 26, 0, 0, 0) / 1000),
    );
  });

  it('honours an explicit zone', () => {
    expect(parseTwelveDataTimestamp('2026-09-26T12:00:00Z')).toBe(
      Math.floor(Date.UTC(2026, 8, 26, 12, 0, 0) / 1000),
    );
  });

  it('returns null for a value it cannot parse', () => {
    expect(parseTwelveDataTimestamp('not-a-date')).toBeNull();
    expect(parseTwelveDataTimestamp('   ')).toBeNull();
  });
});

describe('mapTwelveDataCandles', () => {
  it('parses string numbers and returns oldest-first', () => {
    const { candles, skipped } = mapTwelveDataCandles([
      { datetime: '2026-09-26 12:00:00', open: '2', high: '3', low: '1', close: '2.5' },
      { datetime: '2026-09-26 11:00:00', open: '1', high: '2', low: '0.5', close: '2' },
    ]);

    expect(skipped).toBe(0);
    expect(candles.map((c) => c.time)).toEqual([
      Math.floor(Date.UTC(2026, 8, 26, 11, 0, 0) / 1000),
      Math.floor(Date.UTC(2026, 8, 26, 12, 0, 0) / 1000),
    ]);
    expect(candles[0]).toMatchObject({ open: 1, high: 2, low: 0.5, close: 2 });
  });

  it('drops unusable rows and counts them rather than repairing them', () => {
    const { candles, skipped } = mapTwelveDataCandles([
      { datetime: '2026-09-26 12:00:00', open: '1', high: '2', low: '0.5', close: '1.5' },
      { datetime: 'bad', open: '1', high: '2', low: '0.5', close: '1.5' },
      { datetime: '2026-09-26 13:00:00', open: '1', high: 'nope', low: '0.5', close: '1.5' },
      null,
    ]);

    expect(candles).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('includes volume only when the feed provided one', () => {
    const { candles } = mapTwelveDataCandles([
      { datetime: '2026-09-26 12:00:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '42' },
      { datetime: '2026-09-26 13:00:00', open: '1', high: '2', low: '0.5', close: '1.5' },
    ]);

    expect(candles[0].volume).toBe(42);
    expect('volume' in candles[1]).toBe(false);
  });

  it('tolerates a non-array payload', () => {
    expect(mapTwelveDataCandles(undefined)).toEqual({ candles: [], skipped: 0 });
    expect(mapTwelveDataCandles({ nope: true })).toEqual({ candles: [], skipped: 0 });
  });
});

describe('buildTwelveDataTimeSeriesUrl', () => {
  it('builds a UTC, ascending request without a double slash', () => {
    const url = buildTwelveDataTimeSeriesUrl({
      baseUrl: 'https://api.twelvedata.com/',
      symbol: 'XAU/USD',
      interval: '1h',
      outputsize: 300,
      apiKey: 'test-key',
    });

    expect(url.startsWith('https://api.twelvedata.com/time_series?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('symbol')).toBe('XAU/USD');
    expect(params.get('interval')).toBe('1h');
    expect(params.get('outputsize')).toBe('300');
    expect(params.get('timezone')).toBe('UTC');
    expect(params.get('order')).toBe('ASC');
    expect(params.get('apikey')).toBe('test-key');
  });
});

describe('getTwelveDataCandles (injected transport, no network)', () => {
  const deps = { baseUrl: 'https://api.twelvedata.com' };

  it('refuses without an API key', async () => {
    await expect(
      getTwelveDataCandles('frxXAUUSD', '1h', 10, { ...deps, apiKey: '' }),
    ).rejects.toThrow(/no API key/i);
  });

  it('refuses an unmapped symbol before making a request', async () => {
    let called = false;
    await expect(
      getTwelveDataCandles('R_100', '1h', 10, {
        ...deps,
        apiKey: 'k',
        fetchJson: async () => {
          called = true;
          return { status: 'ok', values: [] };
        },
      }),
    ).rejects.toThrow(/no symbol mapping/i);
    expect(called).toBe(false);
  });

  it('refuses an unsupported timeframe', async () => {
    await expect(
      getTwelveDataCandles('frxXAUUSD', '2h', 10, { ...deps, apiKey: 'k', fetchJson: async () => ({}) }),
    ).rejects.toThrow(/cannot serve/i);
  });

  it('throws on a provider error payload', async () => {
    await expect(
      getTwelveDataCandles('frxXAUUSD', '1h', 10, {
        ...deps,
        apiKey: 'k',
        fetchJson: async () => ({ status: 'error', code: 429, message: 'rate limit exceeded' }),
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });

  it('returns candles on an ok payload', async () => {
    const candles = await getTwelveDataCandles('frxXAUUSD', '1h', 10, {
      ...deps,
      apiKey: 'k',
      fetchJson: async () => ({
        status: 'ok',
        values: [
          { datetime: '2026-09-26 12:00:00', open: '2000', high: '2010', low: '1990', close: '2005' },
        ],
      }),
    });

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 2000, high: 2010, low: 1990, close: 2005 });
  });
});
