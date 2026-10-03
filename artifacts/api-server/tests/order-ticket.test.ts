import './helpers/test-env';

import { describe, expect, it } from 'vitest';

import {
  exposureNotional,
  isTicketValid,
  MAX_STAKE_DECIMAL_PLACES,
  TICKET_LIMITS,
  validateTicket,
  type TicketContext,
  type TicketInput,
} from '@/lib/order-ticket';
import {
  POSITION_MAX_MULTIPLIER,
  POSITION_MAX_STAKE_USD,
  POSITION_MIN_STAKE_USD,
} from '@/server/modules/positions/position.service';

/**
 * Order ticket — the client-side wording that runs before
 * `POST /api/v1/positions` is ever called.
 *
 * Two things are being protected here.
 *
 * 1. THE LIMITS COPY. The ticket runs in the browser and cannot import the
 *    service that owns the limits (it pulls Prisma), so `@/lib/order-ticket`
 *    mirrors them. The first test asserts the mirror still matches the original:
 *    a limit raised on the server must not leave a form that refuses legal
 *    orders, and a limit lowered must not offer illegal ones.
 *
 * 2. THE LEVEL MATH. A stop on the wrong side of the market is filled by the
 *    next tick, and the server does NOT check it (it only requires a positive,
 *    finite price) — so this validation is the only thing standing between a
 *    typo and an immediately-triggered stop.
 */

const PRICE = 4277.71;

function ticket(overrides: Partial<TicketInput> = {}): TicketInput {
  return {
    side: 'BUY',
    stakeUsd: 100,
    multiplier: 1,
    stopLoss: null,
    takeProfit: null,
    ...overrides,
  };
}

function context(overrides: Partial<TicketContext> = {}): TicketContext {
  return { referencePrice: PRICE, availableUsd: 5_000, ...overrides };
}

describe('the ticket mirrors the server limits', () => {
  it('agrees with POSITION_MIN_STAKE_USD / POSITION_MAX_STAKE_USD / POSITION_MAX_MULTIPLIER', () => {
    expect(TICKET_LIMITS.minStakeUsd).toBe(POSITION_MIN_STAKE_USD);
    expect(TICKET_LIMITS.maxStakeUsd).toBe(POSITION_MAX_STAKE_USD);
    expect(TICKET_LIMITS.maxMultiplier).toBe(POSITION_MAX_MULTIPLIER);
  });
});

describe('validateTicket — stake', () => {
  it('accepts a valid stake', () => {
    expect(validateTicket(ticket({ stakeUsd: 100 }), context()).stake).toBeUndefined();
  });

  it('accepts the boundaries', () => {
    expect(validateTicket(ticket({ stakeUsd: POSITION_MIN_STAKE_USD }), context()).stake).toBeUndefined();
    expect(
      validateTicket(ticket({ stakeUsd: POSITION_MAX_STAKE_USD }), context({ availableUsd: 100_000 })).stake,
    ).toBeUndefined();
  });

  it('rejects zero, negative and non-finite stakes', () => {
    for (const stakeUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateTicket(ticket({ stakeUsd }), context()).stake).toBeDefined();
    }
  });

  it('rejects more than two decimal places, exactly as assertStake does', () => {
    expect(MAX_STAKE_DECIMAL_PLACES).toBe(2);
    expect(validateTicket(ticket({ stakeUsd: 10.12 }), context()).stake).toBeUndefined();
    expect(validateTicket(ticket({ stakeUsd: 10.123 }), context()).stake).toMatch(/decimal places/);
  });

  it('rejects a stake above the server maximum', () => {
    expect(
      validateTicket(ticket({ stakeUsd: POSITION_MAX_STAKE_USD + 0.01 }), context({ availableUsd: 1e9 })).stake,
    ).toMatch(/maximum/i);
  });

  it('rejects a stake above available cash, and does not when cash is unknown', () => {
    expect(validateTicket(ticket({ stakeUsd: 600 }), context({ availableUsd: 500 })).stake).toMatch(
      /available cash/,
    );
    expect(validateTicket(ticket({ stakeUsd: 600 }), context({ availableUsd: null })).stake).toBeUndefined();
  });
});

describe('validateTicket — multiplier', () => {
  it('accepts 1 through the maximum', () => {
    expect(validateTicket(ticket({ multiplier: 1 }), context()).multiplier).toBeUndefined();
    expect(validateTicket(ticket({ multiplier: 100 }), context()).multiplier).toBeUndefined();
  });

  it('rejects below 1 and above the maximum', () => {
    expect(validateTicket(ticket({ multiplier: 0 }), context()).multiplier).toBeDefined();
    expect(validateTicket(ticket({ multiplier: -2 }), context()).multiplier).toBeDefined();
    expect(validateTicket(ticket({ multiplier: 101 }), context()).multiplier).toMatch(/may not exceed/);
  });
});

describe('validateTicket — protective levels', () => {
  it('requires a stop below the price on a BUY and above it on a SELL', () => {
    expect(validateTicket(ticket({ side: 'BUY', stopLoss: PRICE - 10 }), context()).stopLoss).toBeUndefined();
    expect(validateTicket(ticket({ side: 'BUY', stopLoss: PRICE + 10 }), context()).stopLoss).toMatch(/below/);
    expect(validateTicket(ticket({ side: 'SELL', stopLoss: PRICE + 10 }), context()).stopLoss).toBeUndefined();
    expect(validateTicket(ticket({ side: 'SELL', stopLoss: PRICE - 10 }), context()).stopLoss).toMatch(/above/);
  });

  it('requires a target above the price on a BUY and below it on a SELL', () => {
    expect(validateTicket(ticket({ side: 'BUY', takeProfit: PRICE + 10 }), context()).takeProfit).toBeUndefined();
    expect(validateTicket(ticket({ side: 'BUY', takeProfit: PRICE - 10 }), context()).takeProfit).toMatch(/above/);
    expect(validateTicket(ticket({ side: 'SELL', takeProfit: PRICE - 10 }), context()).takeProfit).toBeUndefined();
    expect(validateTicket(ticket({ side: 'SELL', takeProfit: PRICE + 10 }), context()).takeProfit).toMatch(/below/);
  });

  it('rejects a level placed exactly at the market — the next tick would fill it', () => {
    expect(validateTicket(ticket({ side: 'BUY', stopLoss: PRICE }), context()).stopLoss).toBeDefined();
    expect(validateTicket(ticket({ side: 'SELL', takeProfit: PRICE }), context()).takeProfit).toBeDefined();
  });

  it('rejects non-positive levels even when no quote has arrived', () => {
    const noQuote = context({ referencePrice: null });
    expect(validateTicket(ticket({ stopLoss: 0 }), noQuote).stopLoss).toBeDefined();
    expect(validateTicket(ticket({ takeProfit: -1 }), noQuote).takeProfit).toBeDefined();
  });

  it('skips the side check when there is no reference price, rather than guessing', () => {
    const noQuote = context({ referencePrice: null });
    expect(validateTicket(ticket({ side: 'BUY', stopLoss: PRICE + 10 }), noQuote).stopLoss).toBeUndefined();
    expect(validateTicket(ticket({ side: 'SELL', takeProfit: PRICE + 10 }), noQuote).takeProfit).toBeUndefined();
  });
});

describe('isTicketValid', () => {
  it('is true only for an empty error map', () => {
    expect(isTicketValid({})).toBe(true);
    expect(isTicketValid({ stake: 'nope' })).toBe(false);
  });

  it('matches validateTicket', () => {
    expect(isTicketValid(validateTicket(ticket(), context()))).toBe(true);
    expect(isTicketValid(validateTicket(ticket({ stakeUsd: 0 }), context()))).toBe(false);
  });
});

describe('exposureNotional', () => {
  it('is stake × multiplier', () => {
    expect(exposureNotional(100, 100)).toBe(10_000);
    expect(exposureNotional(10, 1)).toBe(10);
  });

  it('is null when either factor is unusable, so the readout can say so', () => {
    expect(exposureNotional(Number.NaN, 10)).toBeNull();
    expect(exposureNotional(10, Number.NaN)).toBeNull();
    expect(exposureNotional(0, 10)).toBeNull();
    expect(exposureNotional(10, 0)).toBeNull();
  });
});
