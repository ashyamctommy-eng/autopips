import { serverEnv } from '@/lib/env';
import { ApiError } from '@/lib/http';
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
  providerForSymbol,
} from '@/server/modules/market/twelve-data.service';
import { markPriceFromQuote } from '@/server/modules/market/quote-fanout';
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
let connectionGeneration = 0;

/** Symbols currently streamed from the public feed → their listener count. */
const tickListeners = new Map<string, number>();
/** Subscription id per symbol, so `forget` addresses the right one. */
const subscriptions = new Map<string, string>();

/**
 * The last quote this process actually saw per symbol.
 *
 * Kept so a fill can be priced from a price the platform itself published, rather
 * than a second opinion fetched from another vendor. Only populated while
 * something is streaming the symbol; `getLatestPrice` asks for one quote when it
 * is empty rather than guessing.
 */
const lastQuotes = new Map<string, Quote>();
const quoteListeners = new Map<string, Set<(quote: Quote) => void>>();
let intentionalClose = false;
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTickSubscriptions = new Map<string, Promise<void>>();

/** The last quote seen for a symbol in this process, or null. */
export function lastPublicQuote(symbol: string): Quote | null {
  const quote = lastQuotes.get(symbol);
  return quote && Date.now() / 1000 - quote.time <= 30 ? quote : null;
}

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
    if (!env.DERIV_APP_ID.trim()) {
      throw ApiError.serviceUnavailable('Deriv market data is not configured. Live prices are unavailable.');
    }
    const generation = ++connectionGeneration;
    const next = new DerivClient({
      url: publicUrl(),
      appId: env.DERIV_APP_ID,
      connectTimeoutMs: env.BROKER_CONNECT_TIMEOUT * 1_000,
      onClose: () => {
        // Ignore close events from replaced sockets. They must not clear a newer
        // connection's subscriptions or start a second recovery loop.
        if (generation !== connectionGeneration) return;
        client = null;
        tickListeners.clear();
        subscriptions.clear();
        lastQuotes.clear();
        if (intentionalClose) return;
        for (const symbol of quoteListeners.keys()) schedulePublicTickReconnect(symbol, 2000);
      },
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
  intentionalClose = true;
  connectionGeneration += 1;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  client?.close();
  client = null;
  tickListeners.clear();
  lastQuotes.clear();
  quoteListeners.clear();
}

/**
 * Re-subscribe without changing listener demand. A transient transport error
 * must not erase the callbacks still owned by charts, tickets, and exit watches.
 */
async function ensurePublicTickSubscription(symbol: string): Promise<void> {
  if (tickListeners.has(symbol) || (quoteListeners.get(symbol)?.size ?? 0) === 0) return;
  const pending = pendingTickSubscriptions.get(symbol);
  if (pending) return pending;

  const work = (async () => {
    const socket = await connection();
    if (tickListeners.has(symbol)) return;
    const listeners = quoteListeners.get(symbol);
    if (!listeners?.size) return;

    const result: DerivSubscribeResult = await socket.subscribe(
      { ticks: symbol, subscribe: 1 },
      `public ticks(${symbol})`,
      (message) => {
        const quote = toQuote(symbol, message);
        if (!quote || Date.now() / 1000 - quote.time > 30) return;
        lastQuotes.set(symbol, quote);
        for (const listener of quoteListeners.get(symbol) ?? []) listener(quote);
      },
    );

    // All owners may have released while the upstream request was in flight.
    if ((quoteListeners.get(symbol)?.size ?? 0) === 0) {
      if (result.subscriptionId) await socket.forget(result.subscriptionId);
      return;
    }
    tickListeners.set(symbol, quoteListeners.get(symbol)?.size ?? 0);
    if (result.subscriptionId) subscriptions.set(symbol, result.subscriptionId);
    const first = toQuote(symbol, result.first);
    if (first && Date.now() / 1000 - first.time <= 30) {
      lastQuotes.set(symbol, first);
      for (const listener of quoteListeners.get(symbol) ?? []) listener(first);
    }
  })();
  pendingTickSubscriptions.set(symbol, work);
  try {
    await work;
  } finally {
    if (pendingTickSubscriptions.get(symbol) === work) pendingTickSubscriptions.delete(symbol);
  }
}

function schedulePublicTickReconnect(symbol: string, delayMs: number): void {
  if (intentionalClose || (quoteListeners.get(symbol)?.size ?? 0) === 0) return;
  if (reconnectTimers.has(symbol)) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(symbol);
    if (intentionalClose || (quoteListeners.get(symbol)?.size ?? 0) === 0) return;
    void ensurePublicTickSubscription(symbol).catch((error: unknown) => {
      console.warn(
        `[public-market] re-subscribe failed for ${symbol}; listener demand retained: ${error instanceof Error ? error.message : error}`,
      );
      schedulePublicTickReconnect(symbol, 5000);
    });
  }, delayMs);
  timer.unref?.();
  reconnectTimers.set(symbol, timer);
}

/**
 * Latest traded price for a symbol — read LIVE from the tick feed.
 *
 * Used to price an internal position server-side. That is a SECURITY boundary,
 * not a convenience: a client must never supply its own fill price, or it could
 * open at a favourable print and close at another for a fabricated profit.
 * Returns null when no usable price could be read (caller turns that into a 503).
 *
 * WHY NOT THE CANDLE PROVIDER (2026-09-27)
 *   `MARKET_DATA_PROVIDER=twelve` moved the CHART's history to Twelve Data, but
 *   the live ticks a client sees — and therefore the price on the ticket they
 *   press — still come from Deriv. Pricing the fill from the candle provider
 *   would fill them from a DIFFERENT VENDOR's 1-minute close: a price they never
 *   saw, up to a minute old. So the fill follows the tick feed, and reads it live
 *   rather than from a candle.
 *
 * Order of preference:
 *   1. the last quote this process observed (a price the platform published);
 *   2. a quote asked of the feed, which answers a subscription immediately;
 *   3. the smallest candle's close, when the feed answered neither.
 */
export async function getLatestPrice(symbol: string): Promise<number | null> {
  const observed = lastPublicQuote(symbol);
  if (observed) {
    const mark = markPriceFromQuote(observed);
    if (mark !== null && mark > 0) return mark;
  }

  const live = await readOneQuote(symbol);
  if (live !== null && live > 0) return live;

  // Closed-session history is not an executable live price.
  return null;
}

/** How long a live price request waits for the feed before falling back. */
const QUOTE_TIMEOUT_MS = 3_000;

/**
 * Ask the feed for one live price.
 *
 * A Deriv subscription answers with the current price immediately, so this is one
 * round trip and the subscription is released the moment the price is in hand.
 * Any failure returns null and the caller falls back — a price read must never be
 * the reason an order cannot be placed.
 */
async function readOneQuote(symbol: string): Promise<number | null> {
  let settle: (quote: Quote | null) => void = () => undefined;
  const first = new Promise<Quote | null>((resolve) => {
    settle = resolve;
  });

  let subscription: { unsubscribe: () => Promise<void> };
  try {
    subscription = await subscribePublicTicks(symbol, (quote) => settle(quote));
  } catch (err) {
    console.warn(
      `[public-market] could not read a live price for ${symbol}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  try {
    const quote = await Promise.race([
      first,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), QUOTE_TIMEOUT_MS);
        // A pending price read must not hold the process open.
        timer.unref?.();
      }),
    ]);
    return quote ? markPriceFromQuote(quote) : null;
  } finally {
    await subscription.unsubscribe().catch(() => undefined);
  }
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
  // PER-SYMBOL routing (2026-09-27). The switch used to be global, which broke
  // every instrument the chosen feed does not carry: with
  // `MARKET_DATA_PROVIDER=twelve` a synthetic index (`R_10`, `R_100`) reached a
  // vendor that has no such symbol and the request failed outright.
  // `providerForSymbol` decides per instrument — Twelve Data where it maps and can
  // price it, Deriv everywhere else — so turning the flag on is safe for every
  // listed instrument. A mapped symbol that the vendor then fails to serve is
  // still a loud failure, never a silent substitution.
  if (providerForSymbol(symbol) === 'twelve') {
    return getTwelveDataCandles(symbol, timeframe, count);
  }
  return derivCandles(symbol, timeframe, count);
}

/**
 * Historical candles from Deriv's public feed.
 *
 * Also the fallback price source for `getLatestPrice`: the live ticks the client
 * is shown come from this feed, so pricing an order from it cannot disagree with
 * the screen the client pressed BUY on.
 */
async function derivCandles(
  symbol: string,
  timeframe: string,
  count: number,
): Promise<Candle[]> {
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
  intentionalClose = false;
  const alreadyStreaming = tickListeners.has(symbol);
  await connection();
  const listeners = quoteListeners.get(symbol) ?? new Set<(quote: Quote) => void>();
  listeners.add(onQuote);
  quoteListeners.set(symbol, listeners);

  try {
    await ensurePublicTickSubscription(symbol);
  } catch (error) {
    if (tickListeners.has(symbol)) throw error;
    listeners.delete(onQuote);
    if (listeners.size === 0) quoteListeners.delete(symbol);
    throw error;
  }
  if (alreadyStreaming) {
    const last = lastPublicQuote(symbol);
    if (last) onQuote(last);
  }

  let released = false;
  return {
    unsubscribe: async () => {
      if (released) return;
      released = true;
      quoteListeners.get(symbol)?.delete(onQuote);
      const remaining = quoteListeners.get(symbol)?.size ?? 0;
      if (remaining > 0) {
        tickListeners.set(symbol, remaining);
        return;
      }
      quoteListeners.delete(symbol);
      const timer = reconnectTimers.get(symbol);
      if (timer) clearTimeout(timer);
      reconnectTimers.delete(symbol);
      tickListeners.delete(symbol);
      lastQuotes.delete(symbol);
      const subscriptionId = subscriptions.get(symbol);
      subscriptions.delete(symbol);
      if (subscriptionId && client?.isConnected()) await client.forget(subscriptionId);
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
