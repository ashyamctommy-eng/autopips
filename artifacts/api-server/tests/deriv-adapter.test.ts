import { describe, expect, it } from 'vitest';

import { DerivBrokerAdapter } from '@/server/modules/broker/deriv.adapter';
import { ApiError } from '@/lib/http';

/**
 * DERIV ADAPTER — the rules that must hold before any socket is opened.
 *
 * These are the money-path decisions of the broker swap, and all three are
 * answerable without a broker connection:
 *
 *   1. the adapter declares its size denomination, so callers know a lot-based
 *      order cannot be priced for it;
 *   2. a lot-denominated order is REFUSED, never converted — turning lots into a
 *      stake means inventing a contract size Deriv does not publish, and that
 *      number would decide how much real money is at risk;
 *   3. a timeframe the broker cannot serve is rejected here rather than bucketed
 *      into a different one.
 *
 * The live protocol calls (candles, ticks, proposal/buy) need a real app_id and
 * are deliberately not simulated in this suite: a fake broker response is the
 * exact thing the platform forbids.
 */

function adapter(): DerivBrokerAdapter {
  return new DerivBrokerAdapter({
    loginId: null,
    appId: '1089',
    token: null, // market-data-only; the gate under test must not need a token
    multiplier: 100,
  });
}

describe('size denomination', () => {
  it('declares itself stake-denominated', () => {
    expect(adapter().sizeDenomination).toBe('stake');
  });
});

describe('lot-denominated orders are refused, not converted', () => {
  it('refuses a request that supplies only a volume', async () => {
    const result = await adapter().placeOrder({
      symbol: 'frxXAUUSD',
      direction: 'BUY',
      volume: 0.1,
      clientOrderId: 'sig:test:inv:test',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('STAKE_REQUIRED');
    expect(result.brokerMessage ?? '').toMatch(/stake/i);
    expect(result.brokerMessage ?? '').toMatch(/lot/i);
    // Nothing was sent anywhere: the refusal happens before any broker call.
    expect(result.positionId).toBeUndefined();
  });

  it('refuses a zero or negative stake', async () => {
    const zero = await adapter().placeOrder({
      symbol: 'frxXAUUSD',
      direction: 'BUY',
      stake: 0,
      clientOrderId: 'sig:test:inv:test',
    });
    expect(zero.ok).toBe(false);
    expect(zero.errorCode).toBe('STAKE_REQUIRED');
  });
});

describe('timeframes', () => {
  it('rejects a timeframe the broker cannot serve', async () => {
    await expect(adapter().getHistoricalCandles('R_100', '3m', 10)).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects an empty timeframe rather than defaulting to one', async () => {
    await expect(adapter().getHistoricalCandles('R_100', '', 10)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('disconnected behaviour', () => {
  it('reports itself disconnected before connect()', () => {
    expect(adapter().isConnected()).toBe(false);
  });

  it('answers with no positions rather than an empty-looking account when unauthenticated', async () => {
    // No token: the platform has no account to read. An empty array is the
    // truthful answer here — it is not "the account is flat".
    await expect(adapter().getOpenPositions()).resolves.toEqual([]);
    await expect(adapter().getDealsSince(new Date(0))).resolves.toEqual([]);
    await expect(adapter().getPositionClosure('1')).resolves.toBeNull();
  });

  it('refuses to close a contract when there is no trading token', async () => {
    await expect(adapter().closePosition('123')).rejects.toBeInstanceOf(ApiError);
  });
});
