import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerAdapter, Quote } from '@/server/modules/broker/broker.types';

/**
 * MARKET STREAM DEMAND — the ratchet behind "start streaming when someone is
 * watching, stop when nobody is".
 *
 * The risk this pins down is not cosmetic: a leaked upstream subscription keeps
 * a broker terminal streaming a symbol nobody is looking at (MetaApi quota), and
 * a double subscription makes one symbol cost two. The service's I/O is mocked
 * here — the broker registry and the event bus — so the assertion is about the
 * COUNTING policy, which is the part with the leak.
 */

const mocks = vi.hoisted(() => ({
  connection: { id: 'conn-1', metaApiAccountId: 'acct-1' } as Record<string, unknown> | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  connected: true,
  published: [] as unknown[],
  findFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    brokerConnection: {
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
    },
  },
}));

vi.mock('@/server/modules/broker/broker.registry', () => ({
  getAdapterForConnection: async () => {
    const adapter = {
      accountId: 'acct-1',
      isConnected: () => mocks.connected,
      subscribeToMarketData: (symbol: string) => mocks.subscribe(symbol),
      unsubscribeFromMarketData: (symbol: string) => mocks.unsubscribe(symbol),
    };
    return adapter as unknown as BrokerAdapter;
  },
  ensureBrokerConnected: async (adapter: BrokerAdapter) => adapter,
}));

vi.mock('@/server/ws/event-bus', () => ({
  publishTick: async (payload: unknown) => {
    mocks.published.push(payload);
    return 'local';
  },
}));

/**
 * The service holds live state (streams + in-flight subscriptions) at module
 * scope, exactly as it does in the socket runtime. Each test therefore loads a
 * FRESH copy of the module, so one test's streams cannot leak into the next.
 */
type MarketStream = typeof import('@/server/modules/market/market-stream.service');

let market: MarketStream;

const QUOTE: Quote = { symbol: 'XAUUSD', bid: 1999.5, ask: 2000.5, time: 1_800_000_000 };

beforeEach(async () => {
  mocks.connected = true;
  mocks.connection = { id: 'conn-1', metaApiAccountId: 'acct-1' };
  mocks.findFirst.mockImplementation(async () => mocks.connection);
  mocks.subscribe.mockReset().mockImplementation(async () => QUOTE);
  mocks.unsubscribe.mockReset().mockImplementation(async () => undefined);
  mocks.published.length = 0;

  vi.resetModules();
  market = await import('@/server/modules/market/market-stream.service');
});

describe('demand counting', () => {
  it('subscribes upstream once for N listeners and releases at zero', async () => {
    expect(await market.acquireMarketSymbol('xauusd')).toBe(true); // normalised to XAUUSD
    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(true);

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledWith('XAUUSD');
    expect(market.marketStreamSnapshot()).toEqual([
      { symbol: 'XAUUSD', listeners: 2, connectionId: 'conn-1', connected: true },
    ]);

    await market.releaseMarketSymbol('XAUUSD');
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(market.marketStreamSnapshot()[0].listeners).toBe(1);

    await market.releaseMarketSymbol('XAUUSD');
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).toHaveBeenCalledWith('XAUUSD');
    expect(market.marketStreamSnapshot()).toEqual([]);
  });

  it('publishes the quote the subscription call answered with, so a chart is not blank', async () => {
    await market.acquireMarketSymbol('XAUUSD');
    expect(mocks.published).toContainEqual(QUOTE);
  });

  it('re-subscribes after a full release', async () => {
    await market.acquireMarketSymbol('XAUUSD');
    await market.releaseMarketSymbol('XAUUSD');
    await market.acquireMarketSymbol('XAUUSD');
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it('ignores a release with no matching demand', async () => {
    await market.releaseMarketSymbol('EURUSD');
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it('refuses a symbol that is not one', async () => {
    expect(await market.acquireMarketSymbol('NOT A SYMBOL')).toBe(false);
    expect(await market.acquireMarketSymbol('')).toBe(false);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('reports false and keeps no phantom demand when the platform has no connected account', async () => {
    mocks.connection = null;
    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(false);
    expect(market.marketStreamSnapshot()).toEqual([]);
    expect(mocks.subscribe).not.toHaveBeenCalled();

    // The next acquire must retry rather than inherit a broken entry.
    mocks.connection = { id: 'conn-1', metaApiAccountId: 'acct-1' };
    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(true);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it('reports false when the broker refuses the subscription, and can be retried', async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error('terminal refused'));
    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(false);
    expect(market.marketStreamSnapshot()).toEqual([]);

    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(true);
    expect(market.marketStreamSnapshot()[0].listeners).toBe(1);
  });

  it('rebuilds the stream when the adapter underneath has dropped', async () => {
    await market.acquireMarketSymbol('XAUUSD');
    mocks.connected = false; // connection lost, subscriptions gone with it

    expect(await market.acquireMarketSymbol('XAUUSD')).toBe(true);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(market.marketStreamSnapshot()[0].listeners).toBe(1);
  });
});

describe('reconnect', () => {
  it('re-issues every live subscription after the broker connection comes back', async () => {
    await market.acquireMarketSymbol('XAUUSD');
    await market.acquireMarketSymbol('EURUSD');
    mocks.subscribe.mockClear();
    mocks.published.length = 0;

    await market.reattachMarketSubscriptions();

    expect(mocks.subscribe.mock.calls.map((call) => call[0]).sort()).toEqual(['EURUSD', 'XAUUSD']);
    expect(mocks.published).toHaveLength(2);
    // Listener counts survive the re-attach.
    expect(market.marketStreamSnapshot().map((entry) => entry.listeners)).toEqual([1, 1]);
  });

  it('does nothing when nothing is streaming', async () => {
    await market.reattachMarketSubscriptions();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
