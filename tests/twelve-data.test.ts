import { beforeEach, describe, expect, it } from 'vitest';

import {
  TWELVE_DATA_CREDITS_PER_MINUTE,
  buildTwelveDataUrl,
  resetTwelveDataClientForTests,
  twelveDataClientStats,
  twelveDataFetch,
} from '@/server/modules/market/twelve-data.client';
import {
  DEFAULT_PLATFORM_INSTRUMENTS,
  TWELVE_DATA_SYMBOLS,
  curatedPlatformInstruments,
  fetchTwelveCatalog,
  getTwelveDataCandles,
  getTwelveDataQuotes,
  mapTwelveDataCandles,
  marketDataProvider,
  normalizeCatalogEntries,
  parseTwelveDataTimestamp,
  twelveDataInterval,
  twelveDataSymbol,
} from '@/server/modules/market/twelve-data.service';

/**
 * Twelve Data integration.
 *
 * The three properties that matter:
 *   1. The free-tier CREDIT BUDGET (8/min) is enforced — a burst WAITS, it never
 *      trips 429 and never silently drops a price the position engine needed.
 *   2. Symbols are mapped EXPLICITLY; an unmapped instrument refuses loudly rather
 *      than being proxied into pricing the wrong thing.
 *   3. Nothing is repaired: unusable bars are dropped and counted.
 *
 * Everything is driven through an injected transport, so no network and no key.
 */

const deps = (fetchJson: (url: string) => Promise<unknown>) => ({ fetchJson });
const base = 'https://api.twelvedata.com';

beforeEach(() => {
  resetTwelveDataClientForTests();
});

describe('credit limiter', () => {
  it('waits instead of exceeding the per-minute budget, then proceeds', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fake = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetchJson: async () => ({ price: '1.0' }),
    };

    for (let i = 0; i < TWELVE_DATA_CREDITS_PER_MINUTE; i += 1) {
      await twelveDataFetch('price', { symbol: `S${i}` }, { apiKey: 'k', baseUrl: base, deps: fake });
    }
    expect(twelveDataClientStats().waits).toBe(0);

    // The 9th credit cannot fit in the window, so it must wait for it to roll.
    await twelveDataFetch('price', { symbol: 'S9' }, { apiKey: 'k', baseUrl: base, deps: fake });

    expect(twelveDataClientStats().waits).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(TWELVE_DATA_CREDITS_PER_MINUTE > 0 ? 60_000 - 100 : 0);
  });

  it('counts a batch by CREDITS (one per symbol), not by request', async () => {
    let clock = 0;
    const fake = {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      fetchJson: async () => ({ 'EUR/USD': { price: '1.0' } }),
    };

    await twelveDataFetch(
      'price',
      { symbol: 'EUR/USD,GBP/USD,XAU/USD' },
      { apiKey: 'k', baseUrl: base, credits: 3, deps: fake },
    );

    expect(twelveDataClientStats().creditsInWindow).toBe(3);
  });
});

describe('cache', () => {
  it('serves an identical request from memory and spends no second credit', async () => {
    let calls = 0;
    const fetchJson = async () => {
      calls += 1;
      return { price: '1.0' };
    };

    await twelveDataFetch('price', { symbol: 'EUR/USD' }, { apiKey: 'k', baseUrl: base, ttlSeconds: 30, deps: deps(fetchJson) });
    await twelveDataFetch('price', { symbol: 'EUR/USD' }, { apiKey: 'k', baseUrl: base, ttlSeconds: 30, deps: deps(fetchJson) });

    expect(calls).toBe(1);
    expect(twelveDataClientStats().cacheHits).toBe(1);
    // The cache saved a credit: only ONE was ever reserved.
    expect(twelveDataClientStats().creditsInWindow).toBe(1);
  });
});

describe('error handling', () => {
  it('refuses without a key, and never echoes the key in a message', async () => {
    await expect(twelveDataFetch('price', {}, { apiKey: '' })).rejects.toThrow(/not configured/i);
  });

  it('surfaces a vendor error without leaking the URL (it carries the key)', async () => {
    const fetchJson = async () => ({ status: 'error', code: 400, message: 'invalid symbol' });
    await expect(
      twelveDataFetch('time_series', { symbol: 'NOPE' }, { apiKey: 'secret-key', baseUrl: base, deps: deps(fetchJson) }),
    ).rejects.toThrow(/invalid symbol/);
    await expect(
      twelveDataFetch('time_series', { symbol: 'NOPE' }, { apiKey: 'secret-key', baseUrl: base, deps: deps(fetchJson) }),
    ).rejects.not.toThrow(/secret-key/);
  });

  it('backs off and retries ONCE on a 429 payload', async () => {
    let calls = 0;
    const fetchJson = async () => {
      calls += 1;
      return calls === 1 ? { code: 429, message: 'too many requests' } : { price: '1.0' };
    };
    let clock = 0;
    const fake = {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      fetchJson,
    };

    const result = await twelveDataFetch<{ price: string }>(
      'price',
      { symbol: 'EUR/USD' },
      { apiKey: 'k', baseUrl: base, deps: fake },
    );

    expect(result.price).toBe('1.0');
    expect(calls).toBe(2);
    expect(twelveDataClientStats().rateLimitBackoffs).toBe(1);
  });
});

describe('url building', () => {
  it('builds a UTC, ascending time_series request without a double slash', () => {
    const url = buildTwelveDataUrl(base + '/', 'time_series', {
      symbol: 'XAU/USD',
      interval: '1h',
      outputsize: 30,
      timezone: 'UTC',
      order: 'ASC',
    }, 'test-key');

    expect(url.startsWith('https://api.twelvedata.com/time_series?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('symbol')).toBe('XAU/USD');
    expect(params.get('interval')).toBe('1h');
    expect(params.get('outputsize')).toBe('30');
    expect(params.get('timezone')).toBe('UTC');
    expect(params.get('apikey')).toBe('test-key');
  });
});

describe('symbol + interval mapping', () => {
  it('maps the supported instruments explicitly, including commodities', () => {
    expect(twelveDataSymbol('frxXAUUSD')).toBe('XAU/USD');
    expect(twelveDataSymbol('frxEURUSD')).toBe('EUR/USD');
    // VERIFIED against the live commodities catalog: the bare `WTI`/`BRENT`
    // symbols are DIFFERENT instruments (WTI priced ~3.65) — the real spots are WTI/USD and XBR/USD.
    expect(twelveDataSymbol('comWTIUSD')).toBe('WTI/USD');
    expect(twelveDataSymbol('comBRENTUSD')).toBe('XBR/USD');
    expect(twelveDataSymbol('cryBTCUSD')).toBe('BTC/USD');
  });

  it('refuses Deriv synthetics instead of inventing a proxy', () => {
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

describe('curated platform catalog', () => {
  it('defaults to the LIVE-VALIDATED liquid instruments only', () => {
    const list = curatedPlatformInstruments();
    expect(list).toEqual(expect.arrayContaining([...DEFAULT_PLATFORM_INSTRUMENTS]));
    // Validated priceable on 2026-09-26 with the Basic-plan key:
    for (const symbol of ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD', 'cryBTCUSD', 'cryETHUSD']) {
      expect(list).toContain(symbol);
    }
    // Plan-gated instruments must NOT be offered: they cannot be priced, so a
    // client position on them could never be marked.
    expect(list).not.toContain('comWTIUSD');
    expect(list).not.toContain('comBRENTUSD');
    expect(list).not.toContain('frxXAGUSD');
  });

  it('offers nothing it cannot price (every curated symbol has a Twelve mapping)', () => {
    for (const symbol of DEFAULT_PLATFORM_INSTRUMENTS) {
      expect(TWELVE_DATA_SYMBOLS[symbol], `${symbol} has no price source`).toBeDefined();
    }
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
});

describe('candles, quotes and catalogs through the client', () => {
  it('returns candles on an ok payload', async () => {
    const candles = await getTwelveDataCandles('frxXAUUSD', '1h', 10, {
      apiKey: 'k',
      baseUrl: base,
      deps: deps(async () => ({
        status: 'ok',
        values: [{ datetime: '2026-09-26 12:00:00', open: '2000', high: '2010', low: '1990', close: '2005' }],
      })),
    });
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 2000, high: 2010, low: 1990, close: 2005 });
  });

  it('refuses an unmapped symbol before spending a credit', async () => {
    let called = false;
    await expect(
      getTwelveDataCandles('R_100', '1h', 10, {
        apiKey: 'k',
        baseUrl: base,
        deps: deps(async () => {
          called = true;
          return { status: 'ok', values: [] };
        }),
      }),
    ).rejects.toThrow(/no symbol mapping/i);
    expect(called).toBe(false);
    expect(twelveDataClientStats().requests).toBe(0);
  });

  it('prices a batch and reports symbols the vendor could not price', async () => {
    const result = await getTwelveDataQuotes(['frxEURUSD', 'frxXAUUSD', 'R_100'], {
      apiKey: 'k',
      baseUrl: base,
      deps: deps(async () => ({
        'EUR/USD': { price: '1.0850' },
        'XAU/USD': { price: '2650.12' },
      })),
    });

    expect(result.prices).toEqual({ frxEURUSD: 1.085, frxXAUUSD: 2650.12 });
    // R_100 has no mapping at all (a synthetic), so it is reported missing.
    expect(result.missing).toContain('R_100');
    // Two mapped symbols = two credits, not one request.
    expect(twelveDataClientStats().creditsInWindow).toBe(2);
  });

  it('excludes a known plan-gated instrument without spending a batch on it', async () => {
    const result = await getTwelveDataQuotes(['frxEURUSD', 'comWTIUSD'], {
      apiKey: 'k',
      baseUrl: base,
      deps: deps(async () => ({ 'EUR/USD': { price: '1.1' } })),
    });

    expect(result.prices).toEqual({ frxEURUSD: 1.1 });
    expect(result.missing).toContain('comWTIUSD');
    expect(result.unavailable.comWTIUSD).toMatch(/plan/i);
    // Only the one priceable symbol was requested.
    expect(twelveDataClientStats().creditsInWindow).toBe(1);
  });

  it('isolates a refused symbol instead of losing the whole batch', async () => {
    // VERIFIED vendor behaviour: one gated symbol 404s the entire batch, so the
    // good symbols must be recovered one at a time.
    let call = 0;
    const fetchJson = async () => {
      call += 1;
      if (call === 1) throw new Error('Twelve Data answered HTTP 404.');
      return { price: '1.5' };
    };

    const result = await getTwelveDataQuotes(['frxEURUSD', 'frxGBPUSD'], {
      apiKey: 'k',
      baseUrl: base,
      deps: { fetchJson, sleep: async () => undefined, now: () => 0 },
    });

    expect(Object.keys(result.prices)).toHaveLength(2);
    expect(call).toBe(3); // 1 failed batch + 1 call per symbol
  });

  it('normalises each catalog shape into { symbol, name, kind }', () => {
    expect(
      normalizeCatalogEntries('forex_pairs', {
        data: [{ symbol: 'EUR/USD', currency_base: 'EUR', currency_quote: 'USD' }],
      }),
    ).toEqual([{ symbol: 'EUR/USD', name: 'EUR', kind: 'forex_pairs' }]);

    expect(
      normalizeCatalogEntries('commodities', {
        data: [{ symbol: 'WTI', name: 'Crude Oil WTI' }, { symbol: '' }, null],
      }),
    ).toEqual([{ symbol: 'WTI', name: 'Crude Oil WTI', kind: 'commodities' }]);

    // Malformed payloads degrade to an empty list instead of throwing.
    expect(normalizeCatalogEntries('stocks', { nope: true })).toEqual([]);
    expect(normalizeCatalogEntries('etfs', null)).toEqual([]);
  });

  it('fetches a catalog through the limiter', async () => {
    const entries = await fetchTwelveCatalog('cryptocurrencies', {
      apiKey: 'k',
      baseUrl: base,
      deps: deps(async () => ({ data: [{ symbol: 'BTC/USD', name: 'Bitcoin' }] })),
    });
    expect(entries).toEqual([{ symbol: 'BTC/USD', name: 'Bitcoin', kind: 'cryptocurrencies' }]);
    expect(twelveDataClientStats().requests).toBe(1);
  });
});
