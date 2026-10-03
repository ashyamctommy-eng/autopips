import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{ options: { onClose?: (reason: string) => void }; connected: boolean }>,
  subscribe: vi.fn(),
  forget: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({
    DERIV_APP_ID: '1089',
    DERIV_API_URL: 'wss://ws.derivws.com/websockets/v3',
    BROKER_CONNECT_TIMEOUT: 2,
  }),
}));

vi.mock('@/lib/http', () => ({
  ApiError: { serviceUnavailable: (message: string) => new Error(message) },
}));

vi.mock('@/server/modules/broker/deriv.client', () => ({
  DerivClient: class FakeDerivClient {
    connected = false;
    options: { onClose?: (reason: string) => void };
    constructor(options: { onClose?: (reason: string) => void }) {
      this.options = options;
      mocks.instances.push(this);
    }
    async connect() { this.connected = true; }
    isConnected() { return this.connected; }
    async subscribe(...args: unknown[]) { return mocks.subscribe(this, ...args); }
    async forget(id: string) { return mocks.forget(id); }
    close() { this.connected = false; }
    async request() { return {}; }
  },
}));

vi.mock('@/server/modules/broker/deriv.adapter', () => ({
  GRANULARITY_SECONDS: {},
  mapDerivActiveSymbols: () => [],
  mapDerivCandles: () => ({ candles: [], skipped: 0 }),
}));

vi.mock('@/server/modules/market/twelve-data.service', () => ({
  getTwelveDataCandles: vi.fn(),
  providerForSymbol: () => 'deriv',
}));

vi.mock('@/server/modules/market/quote-fanout', () => ({
  markPriceFromQuote: (quote: { quote: number | null; bid: number | null; ask: number | null }) =>
    quote.quote ?? quote.bid ?? quote.ask,
}));

type PublicMarket = typeof import('@/server/modules/market/public-market.service');
let market: PublicMarket;

function result(subscriptionId: string) {
  return {
    subscriptionId,
    first: { tick: { symbol: 'R_100', epoch: Math.floor(Date.now() / 1000), quote: 123.45 } },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
  mocks.instances.length = 0;
  mocks.forget.mockReset().mockResolvedValue(undefined);
  mocks.subscribe.mockReset().mockImplementation(async (_client, _payload, _label, _onMessage) =>
    result(`subscription-${mocks.subscribe.mock.calls.length}`),
  );
  vi.resetModules();
  market = await import('@/server/modules/market/public-market.service');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('public feed listener recovery', () => {
  it('retains chart and exit-watch listeners through a transient reconnect failure, then resumes ticks', async () => {
    const chartListener = vi.fn();
    const exitWatchListener = vi.fn();
    const chartSubscription = await market.subscribePublicTicks('R_100', chartListener);
    const exitWatchSubscription = await market.subscribePublicTicks('R_100', exitWatchListener);
    chartListener.mockClear();
    exitWatchListener.mockClear();

    const firstSocket = mocks.instances[0];
    firstSocket.connected = false;
    firstSocket.options.onClose?.('simulated network close');

    mocks.subscribe.mockRejectedValueOnce(new Error('simulated temporary subscription timeout'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);

    // A second attempt succeeds without requiring either consumer to re-register.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
    const resumedOnMessage = mocks.subscribe.mock.calls[2][3] as (message: Record<string, unknown>) => void;
    resumedOnMessage({
      tick: { symbol: 'R_100', epoch: Math.floor(Date.now() / 1000), quote: 124.5 },
    });

    expect(chartListener).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'R_100', quote: 124.5 }));
    expect(exitWatchListener).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'R_100', quote: 124.5 }));

    await chartSubscription.unsubscribe();
    await exitWatchSubscription.unsubscribe();
    expect(mocks.forget).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after every owner releases during reconnect', async () => {
    const listener = vi.fn();
    const subscription = await market.subscribePublicTicks('R_100', listener);
    mocks.instances[0].connected = false;
    mocks.instances[0].options.onClose?.('simulated network close');
    await subscription.unsubscribe();

    mocks.subscribe.mockRejectedValueOnce(new Error('temporary failure'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.instances).toHaveLength(1);
  });
});