import { serverEnv } from '@/lib/env';
import {
  DerivClient,
  type DerivSubscribeResult,
} from '@/server/modules/broker/deriv.client';
import {
  GRANULARITY_SECONDS,
  mapDerivActiveSymbols,
  mapDerivCandles,
} from '@/server/modules/broker/deriv.adapter';
import {
  getTwelveDataCandles,
  marketDataProvider,
} from '@/server/modules/market/twelve-data.service';
import type { Candle, InstrumentInfo, Quote } from '@/server/modules/broker/broker.types';

/**
 * Deriv PUBLIC market data — prices and history, with no account attached.
 *
 * WHY THIS EXISTS
 * ---------------
 * Market data used to be read through a registered `BrokerConnection`: the
 * candles route resolved the connection behind the caller's own trades, so a
 * client with no trades saw `source: 'none'` and an empty chart — even though
 * the prices themselves have never needed an account. On Deriv they genuinely
 * do not: the public socket is unauthenticated by design.
 *
 * Tying a public feed to a private account also made the chart fragile in a way
 * nothing could fix from the client: no connection, no chart.
 *
 * ONE SHARED SOCKET
 * -----------------
 * Deriv counts subscriptions and connections; a socket per request would trip
 * both. This module owns a single lazily-created connection, guarded against
 * concurrent first use, plus a refcounted tick registry — the same
 * demand-driven discipline the private path uses (see
 * [[autopips-market-data-architecture]]).
 *
 * STILL ZERO FABRICATION: every value here came off the wire. A bar with an
 * unusable field is dropped and counted, never repaired; a failed read returns
 * an empty series with a reason, never a synthesised one.
 */

let client: DerivClient | null = null;
let connecting: Promise<DerivClient> | null = null;

/** Symbols currently streamed from the public feed → their listener count. */
const tickListeners = new Map<string, number>();
/** Subscription id per symbol, so `forget` addresses the right one. */
const subscriptions = new Map<string, string>();

/** Deriv's own ceiling for counting candles in one history call. */
const MAX_CANDLES = 1_000;

function publicUrl(): string {
  return serverEnv().DERIV_API_URL;
}

/**
 * The shared public connection, created on first use.
 *
 * `connectTimeoutMs` comes from the environment contract rather than a literal,
 * so a slow network is tuned in one place. Failures are NOT cached: a broker
 * outage must not leave the process permanently convinced the feed is down.
 */
async function connection(): Promise<DerivClient> {
  if (client?.isConnected()) return client;

  connecting ??= (async () => {
    const env = serverEnv();
    const next = new DerivClient({
      url: publicUrl(),
      appId: env.DERIV_APP_ID,
      connectTimeoutMs: env.BROKER_CONNECT_TIMEOUT * 1_000,
    });
    await next.connect();
    client = next;
    return next;
  })();

  try {
    return await connecting;
  } catch (err) {
    console.error(
      `[public-market] could not open the Deriv market-data socket: ${err instanceof Error ? err.message : err}`,
    );
    throw err;
  } finally {
    connecting = null;
  }
}

/** Drop the shared socket (shutdown, or after a fatal protocol error). */
export function closePublicMarketConnection(): void {
  client?.close();
  client = null;
  tickListeners.clear();
}

/**
 * Historical candles for one instrument.
 *
 * Throws only when the feed itself cannot be reached; an instrument the broker
 * has no history for is simply an empty array.
 */
export async function getPublicCandles(
  symbol: string,
  timeframe: string,
  count: number,
): Promise<Candle[]> {
  // Provider switch (MARKET_DATA_PROVIDER). Defaults to the Deriv public feed, so
  // this is a no-op until an operator sets it deliberately. Twelve Data is not a
  // drop-in: it has no mapping for Deriv synthetics (R_10/R_100) and will refuse
  // them, which is the correct loud failure rather than pricing the wrong thing.
  if (marketDataProvider() === 'twelve') {
    return getTwelveDataCandles(symbol, timeframe, count);
  }

  const granularity = GRANULARITY_SECONDS[timeframe];
  if (!granularity) {
    throw new Error(`Deriv cannot serve the ${timeframe} timeframe.`);
  }

  const socket = await connection();
  const limit = Math.max(1, Math.min(Math.trunc(count), MAX_CANDLES));

  const response = await socket.request<{ candles?: unknown }>(
    {
      ticks_history: symbol,
      style: 'candles',
      granularity,
      count: limit,
      end: 'latest',
    },
    `public ticks_history(${symbol} ${timeframe})`,
  );

  const { candles, skipped } = mapDerivCandles(response.candles);
  if (skipped > 0) {
    console.warn(
      `[public-market] ${skipped} candle(s) for ${symbol} ${timeframe} had unusable fields and were dropped.`,
    );
  }

  return candles;
}

/**
 * The instruments the broker actually offers.
 *
 * `product_type` is NOT sent: the current endpoint rejects it outright
 * ("Properties not allowed: product_type"). The payload is mapped by the same
 * function the authorised path uses, so the field-name change on Deriv's side
 * (`underlying_symbol`) cannot make one path see instruments and the other none.
 */
export async function listPublicSymbols(): Promise<InstrumentInfo[]> {
  const socket = await connection();
  const response = await socket.request<{ active_symbols?: unknown }>(
    { active_symbols: 'brief' },
    'public active_symbols',
  );

  return mapDerivActiveSymbols(response.active_symbols).sort((a, b) =>
    a.symbol.localeCompare(b.symbol),
  );
}

/**
 * Subscribe to a symbol's ticks, refcounted per symbol.
 *
 * The caller gets the first quote immediately (Deriv answers a subscription with
 * the current price), so a chart has a value before the next terminal push.
 */
export async function subscribePublicTicks(
  symbol: string,
  onQuote: (quote: Quote) => void,
): Promise<{ unsubscribe: () => Promise<void> }> {
  const socket = await connection();
  const existing = tickListeners.get(symbol) ?? 0;

  if (existing === 0) {
    const result: DerivSubscribeResult = await socket.subscribe(
      { ticks: symbol, subscribe: 1 },
      `public ticks(${symbol})`,
      (message) => {
        const quote = toQuote(symbol, message);
        if (quote) onQuote(quote);
      },
    );
    tickListeners.set(symbol, 1);
    if (result.subscriptionId) subscriptions.set(symbol, result.subscriptionId);

    // Deriv answers a subscription with the current price: publish it so a chart
    // has a value immediately instead of waiting for the next terminal push.
    const first = toQuote(symbol, result.first);
    if (first) onQuote(first);
  } else {
    tickListeners.set(symbol, existing + 1);
  }

  let released = false;
  return {
    unsubscribe: async () => {
      if (released) return;
      released = true;
      const remaining = (tickListeners.get(symbol) ?? 1) - 1;
      if (remaining > 0) {
        tickListeners.set(symbol, remaining);
        return;
      }
      tickListeners.delete(symbol);
      const subscriptionId = subscriptions.get(symbol);
      subscriptions.delete(symbol);
      if (subscriptionId) await socket.forget(subscriptionId);
    },
  };
}

/**
 * Deriv quotes synthetics with a single `quote` and forex/CFDs with bid/ask.
 * A message with none of the three is not a price and is ignored.
 */
function toQuote(symbol: string, message: Record<string, unknown>): Quote | null {
  const tick = message.tick;
  if (typeof tick !== 'object' || tick === null) return null;
  const raw = tick as Record<string, unknown>;

  const epoch = raw.epoch;
  const time = typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : null;
  if (time === null) return null;

  const bid = typeof raw.bid === 'number' && Number.isFinite(raw.bid) ? raw.bid : null;
  const ask = typeof raw.ask === 'number' && Number.isFinite(raw.ask) ? raw.ask : null;
  const quote = typeof raw.quote === 'number' && Number.isFinite(raw.quote) ? raw.quote : null;
  if (bid === null && ask === null && quote === null) return null;

  return { symbol: typeof raw.symbol === 'string' ? raw.symbol : symbol, bid, ask, quote, time };
}
