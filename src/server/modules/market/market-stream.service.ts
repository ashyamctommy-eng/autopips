import type { BrokerConnection } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { normaliseMarketSymbol } from '@/lib/contracts';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
} from '@/server/modules/broker/broker.registry';
import type { BrokerAdapter } from '@/server/modules/broker/broker.types';
import { publishTick } from '@/server/ws/event-bus';

/**
 * MARKET DATA DEMAND MANAGER — the bridge between "a client is watching a
 * symbol" and "the broker terminal is streaming it".
 *
 * WHY THIS EXISTS
 *   A MetaApi streaming connection only pushes prices for symbols the terminal
 *   has been told to stream (or that the account holds a position in). The
 *   adapter already maps `onSymbolPriceUpdated` → `onQuote` →
 *   `publishTick()` → Socket.IO, but NOTHING ever called
 *   `subscribeToMarketData`, so for a symbol the account merely watched, no
 *   tick was ever produced. This service owns that call.
 *
 * REFERENCE COUNTING, NOT BOOLEANS
 *   N clients may watch the same symbol. The upstream subscription must exist
 *   while at least one of them does and disappear when the last one leaves, so
 *   demand is counted per symbol. `release` is idempotent from the caller's
 *   point of view: it decrements and only unsubscribes at zero.
 *
 * ONE ADAPTER FOR ALL SYMBOLS
 *   Ticks are symbol-scoped public market data, not account-scoped, so every
 *   symbol is streamed from the most recently active CONNECTED broker
 *   connection. When that connection is rebuilt, `reattachMarketSubscriptions()`
 *   puts the subscriptions back (MetaApi drops them with the connection).
 *
 * FAILURE POLICY
 *   Nothing here throws to the caller. A client asking to watch a symbol must
 *   never be able to break the socket layer, and a broker outage must degrade to
 *   "the chart shows its empty state" rather than "the dashboard errors".
 *   `acquire` returning false means "no feed available", which the socket layer
 *   reports to the client as an explicit, honest signal.
 */

interface SymbolStream {
  /** Outstanding acquire() calls for this symbol. */
  listeners: number;
  connectionId: string;
  adapter: BrokerAdapter;
}

/** Live streams, keyed by normalised symbol. */
const streams = new Map<string, SymbolStream>();
/** In-flight first-subscription per symbol, so N simultaneous joins cost one call. */
const pending = new Map<string, Promise<boolean>>();

/**
 * Upper bound on simultaneous upstream subscriptions.
 *
 * A runaway client cannot ask the broker to stream the whole instrument list:
 * the socket layer already caps market rooms per connection, and this is the
 * platform-wide backstop (MetaApi accounts have subscription limits).
 */
const MAX_STREAMED_SYMBOLS = 50;

/** The connection that serves watched symbols: the freshest CONNECTED account. */
async function resolveStreamingConnection(): Promise<BrokerConnection | null> {
  return prisma.brokerConnection.findFirst({
    where: { status: 'CONNECTED' },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * Start streaming one symbol on one adapter.
 *
 * Isolated so the caller can single-flight it and so every failure path has one
 * exit: returns false, logs the reason, never throws.
 */
async function startStream(symbol: string, listeners: number): Promise<boolean> {
  try {
    const connection = await resolveStreamingConnection();
    if (!connection) {
      console.warn(
        `[market-stream] no CONNECTED broker account — ${symbol} will not stream (the chart keeps its REST snapshot).`,
      );
      return false;
    }

    const adapter = await ensureBrokerConnected(await getAdapterForConnection(connection));
    const quote = await adapter.subscribeToMarketData(symbol);

    streams.set(symbol, { listeners, connectionId: connection.id, adapter });

    // The subscription call answers with the current price: publish it so a chart
    // has a first tick immediately instead of waiting for the next terminal push.
    if (quote) await publishTick({ ...quote });

    console.info(
      `[market-stream] streaming ${symbol} via account=${adapter.accountId} connection=${connection.id}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[market-stream] could not stream ${symbol}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Register demand for a symbol's live feed.
 *
 * Returns true when a broker subscription is (already) in place, false when the
 * platform cannot stream it right now — no connected broker account, broker
 * refused the subscription, or the platform-wide cap was reached.
 */
export async function acquireMarketSymbol(rawSymbol: string): Promise<boolean> {
  const symbol = normaliseMarketSymbol(rawSymbol);
  if (!symbol) return false;

  const existing = streams.get(symbol);
  if (existing) {
    if (existing.adapter.isConnected()) {
      existing.listeners += 1;
      return true;
    }
    // The adapter dropped under us; rebuild rather than trust a dead stream.
    streams.delete(symbol);
  }

  const inFlight = pending.get(symbol);
  if (inFlight) {
    const started = await inFlight;
    if (started) {
      const entry = streams.get(symbol);
      if (entry) entry.listeners += 1;
    }
    return started;
  }

  if (streams.size >= MAX_STREAMED_SYMBOLS) {
    console.warn(
      `[market-stream] refusing ${symbol}: ${streams.size} symbols already streaming (cap ${MAX_STREAMED_SYMBOLS}).`,
    );
    return false;
  }

  const work = startStream(symbol, 1);
  pending.set(symbol, work);
  try {
    return await work;
  } finally {
    pending.delete(symbol);
  }
}

/** Drop one unit of demand; the upstream subscription is released at zero. */
export async function releaseMarketSymbol(rawSymbol: string): Promise<void> {
  const symbol = normaliseMarketSymbol(rawSymbol);
  if (!symbol) return;

  const entry = streams.get(symbol);
  if (!entry) return;

  entry.listeners -= 1;
  if (entry.listeners > 0) return;

  streams.delete(symbol);
  await entry.adapter.unsubscribeFromMarketData(symbol);
}

/**
 * Re-establish every live subscription after a broker connection came back.
 *
 * Called when the socket runtime sees a `broker:status` event with
 * `connected: true`: MetaApi tears subscriptions down with the connection, so
 * the streams map would otherwise look healthy while producing nothing.
 */
export async function reattachMarketSubscriptions(): Promise<void> {
  const symbols = Array.from(streams.keys());
  if (symbols.length === 0) return;

  for (const symbol of symbols) {
    const entry = streams.get(symbol);
    if (!entry) continue;

    if (entry.adapter.isConnected()) {
      // Same connection, but the server-side subscription is gone.
      try {
        const quote = await entry.adapter.subscribeToMarketData(symbol);
        if (quote) await publishTick({ ...quote });
      } catch (err) {
        console.warn(
          `[market-stream] re-subscribe failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      continue;
    }

    // The adapter was rebuilt: restart the stream and keep the listener count.
    const { listeners } = entry;
    streams.delete(symbol);
    await startStream(symbol, listeners);
  }
}

/** Observability: what the bridge is streaming right now. */
export function marketStreamSnapshot(): Array<{
  symbol: string;
  listeners: number;
  connectionId: string;
  connected: boolean;
}> {
  return Array.from(streams.entries())
    .map(([symbol, entry]) => ({
      symbol,
      listeners: entry.listeners,
      connectionId: entry.connectionId,
      connected: entry.adapter.isConnected(),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
