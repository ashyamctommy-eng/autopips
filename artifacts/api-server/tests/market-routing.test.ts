import './helpers/test-env';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PLAN_GATED_INSTRUMENTS,
  providerForSymbol,
  TWELVE_DATA_SYMBOLS,
} from '@/server/modules/market/twelve-data.service';

/**
 * Per-instrument market-data routing.
 *
 * The bug this pins: `MARKET_DATA_PROVIDER` used to select a feed for the WHOLE
 * deployment. Twelve Data carries no Deriv synthetics, and
 * `getTwelveDataCandles` throws on an unmapped symbol — so turning the flag on
 * broke every synthetic index (`R_10`, `R_100`) outright: no chart, and no fill
 * price, because `getLatestPrice` went through the same switch.
 *
 * The flag now means "prefer Twelve Data", and `providerForSymbol` decides per
 * instrument. These tests hold that line: mapped and priceable → Twelve Data;
 * everything the vendor cannot serve → Deriv; and a mapped symbol that merely
 * needs a bigger plan → Deriv too, because a guaranteed failure is worse than the
 * other feed.
 *
 * `marketDataProvider()` reads `process.env` on every call (deliberately, so an
 * operator's change takes effect without a restart), which is what makes both
 * states testable in one process.
 */

const FLAG = 'MARKET_DATA_PROVIDER';
let original: string | undefined;

beforeEach(() => {
  original = process.env[FLAG];
});

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe('providerForSymbol — flag off', () => {
  it('is Deriv for everything, mapped or not (the unchanged default)', () => {
    delete process.env[FLAG];
    for (const symbol of ['frxXAUUSD', 'frxEURUSD', 'cryBTCUSD', 'R_10', 'R_100', 'NOT_A_SYMBOL']) {
      expect(providerForSymbol(symbol)).toBe('deriv');
    }
  });

  it('treats an unrecognised flag value as Deriv rather than guessing', () => {
    process.env[FLAG] = 'DERIV';
    expect(providerForSymbol('frxXAUUSD')).toBe('deriv');
  });
});

describe('providerForSymbol — flag on', () => {
  beforeEach(() => {
    process.env[FLAG] = 'twelve';
  });

  it('routes mapped FX, metals and crypto to Twelve Data', () => {
    for (const symbol of ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD', 'cryBTCUSD', 'cryETHUSD']) {
      expect(providerForSymbol(symbol)).toBe('twelve');
    }
  });

  it('falls back to Deriv for synthetic indices, which Twelve Data does not carry', () => {
    // The regression: these used to be sent to a vendor that has no such symbol.
    for (const symbol of ['R_10', 'R_100', 'R_25', 'R_75', 'BOOM500', 'CRASH300']) {
      expect(providerForSymbol(symbol)).toBe('deriv');
    }
  });

  it('falls back to Deriv for symbols that are not in the mapping at all', () => {
    expect(providerForSymbol('NOT_A_SYMBOL')).toBe('deriv');
    expect(providerForSymbol('')).toBe('deriv');
  });

  it('falls back to Deriv for plan-gated instruments, which this plan cannot price', () => {
    const gated = Object.keys(PLAN_GATED_INSTRUMENTS);
    expect(gated.length).toBeGreaterThan(0);
    for (const symbol of gated) {
      expect(providerForSymbol(symbol)).toBe('deriv');
    }
  });

  it('trims the flag, so a trailing space still selects Twelve Data', () => {
    process.env[FLAG] = '  twelve  ';
    expect(providerForSymbol('frxEURUSD')).toBe('twelve');
  });
});

describe('the mapping and the gate stay honest', () => {
  it('never claims a synthetic index, which would price something the client did not choose', () => {
    for (const symbol of Object.keys(TWELVE_DATA_SYMBOLS)) {
      expect(symbol.startsWith('R_')).toBe(false);
    }
  });

  it('only gates instruments it actually maps — a gate is about pricing, not mapping', () => {
    for (const symbol of Object.keys(PLAN_GATED_INSTRUMENTS)) {
      expect(TWELVE_DATA_SYMBOLS[symbol]).toBeDefined();
    }
  });
});
