import './helpers/test-env';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BIQUOTE_SYMBOLS,
  biquoteFallbackEnabled,
  biquoteQuoteFromTick,
  biquoteSymbol,
} from '@/server/modules/market/biquote.service';

/**
 * The biquote fallback feed (pilot).
 *
 * Two things must hold and nothing else: the symbol mapping is explicit and
 * verified (never invented), and a STALE tick is never published as live — a
 * closed market sends one snapshot carrying Friday's timestamp on subscribe, and
 * pushing that as a quote would show a frozen price as if the market were open.
 */

const FLAG = 'MARKET_FALLBACK_PROVIDER';
const AGE = 'BIQUOTE_MAX_AGE_SECONDS';
let savedFlag: string | undefined;
let savedAge: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  savedAge = process.env[AGE];
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedAge === undefined) delete process.env[AGE];
  else process.env[AGE] = savedAge;
});

describe('biquoteSymbol', () => {
  it('maps the FX, metal, index, crypto and stock instruments it was verified against', () => {
    expect(biquoteSymbol('frxXAUUSD')).toBe('XAUUSD');
    expect(biquoteSymbol('frxEURUSD')).toBe('EURUSD');
    expect(biquoteSymbol('comWTIUSD')).toBe('USOIL');
    expect(biquoteSymbol('cryBTCUSD')).toBe('BTCUSD');
    expect(biquoteSymbol('stockAAPL')).toBe('AAPL');
  });

  it('refuses the Deriv synthetics it cannot serve', () => {
    for (const symbol of ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ100V', 'BOOM1000']) {
      expect(biquoteSymbol(symbol)).toBeNull();
    }
    expect(BIQUOTE_SYMBOLS.R_100).toBeUndefined();
  });

  it('returns null for an unknown symbol rather than guessing', () => {
    expect(biquoteSymbol('frxZZZUSD')).toBeNull();
  });
});

describe('biquoteFallbackEnabled', () => {
  it('is off unless the flag is exactly `biquote`', () => {
    delete process.env[FLAG];
    expect(biquoteFallbackEnabled()).toBe(false);
    process.env[FLAG] = '';
    expect(biquoteFallbackEnabled()).toBe(false);
    process.env[FLAG] = 'twelve';
    expect(biquoteFallbackEnabled()).toBe(false);
    process.env[FLAG] = 'BIQUOTE';
    expect(biquoteFallbackEnabled()).toBe(true);
  });
});

describe('biquoteQuoteFromTick', () => {
  const NOW = Date.parse('2026-10-11T12:00:00Z');

  it('maps a vendor tick to the platform symbol with bid/ask', () => {
    const quote = biquoteQuoteFromTick(
      { symbol: 'EURUSD', bid: 1.1, ask: 1.1002, mid: 1.1001, timestamp: '2026-10-11T11:59:58Z' },
      NOW,
    );
    expect(quote).toEqual({ symbol: 'frxEURUSD', bid: 1.1, ask: 1.1002, time: Date.parse('2026-10-11T11:59:58Z') / 1000 });
  });

  it('uses `mid` as the single price when there is no bid/ask', () => {
    const quote = biquoteQuoteFromTick(
      { symbol: 'XAUUSD', mid: 4200.5, timestamp: '2026-10-11T11:59:00Z' },
      NOW,
    );
    expect(quote?.quote).toBe(4200.5);
    expect(quote?.bid).toBeNull();
  });

  it('DROPS a stale (closed-market) snapshot instead of publishing it as live', () => {
    const fridayClose = { symbol: 'EURUSD', bid: 1.12, ask: 1.1201, timestamp: '2026-10-09T20:58:29Z' };
    expect(biquoteQuoteFromTick(fridayClose, NOW)).toBeNull();

    process.env[AGE] = '999999999';
    expect(biquoteQuoteFromTick(fridayClose, NOW)).not.toBeNull();
  });

  it('drops an unknown symbol and an unparseable timestamp', () => {
    expect(biquoteQuoteFromTick({ symbol: 'ZZZUSD', bid: 1, timestamp: '2026-10-11T11:59:00Z' }, NOW)).toBeNull();
    expect(biquoteQuoteFromTick({ symbol: 'EURUSD', bid: 1, timestamp: 'not-a-date' }, NOW)).toBeNull();
  });
});
