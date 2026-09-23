import { z } from 'zod';

import { handler, ok } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { requireSessionUser } from '@/server/modules/auth/session';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
} from '@/server/modules/broker/broker.registry';
import type { Candle } from '@/server/modules/broker/broker.types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/market/candles?symbol=XAUUSD&timeframe=1h&limit=300
 *
 * Historical candles straight from the broker adapter
 * (`BrokerAdapter.getHistoricalCandles`) for an authenticated client.
 *
 * ZERO FABRICATION: this route has exactly one data source — the MetaApi
 * account behind the caller's own trade records. When there is no broker
 * connection for the caller, or the adapter cannot serve the request, the
 * response is an EMPTY candle array with `ok: true` and a `source` that says
 * why. The chart renders its empty state; nothing is interpolated, resampled or
 * filled in.
 *
 * The response is `{ symbol, timeframe, candles, source }`, where `source` is:
 *   'broker'      — the broker answered (candles may still be empty for an
 *                   instrument it has never traded);
 *   'none'        — the caller has no broker connection to read from;
 *   'unavailable' — the connection exists but the broker call failed.
 */

/** Symbols the bridge can be asked for: letters, digits and common separators. */
const SYMBOL_PATTERN = /^[A-Z0-9._#+-]{2,24}$/;

/**
 * Timeframes the MetaApi history endpoint accepts. Anything else is rejected
 * here rather than passed through, so a typo cannot become a broker error.
 */
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

const MAX_CANDLES = 1000;

const querySchema = z.object({
  symbol: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => SYMBOL_PATTERN.test(value), 'Symbol must be a market instrument name.'),
  timeframe: z.enum(TIMEFRAMES),
  limit: z.coerce.number().int().min(1).max(MAX_CANDLES).default(300),
});

/**
 * The broker connection that serves this client.
 *
 * `BrokerConnection` is a platform-level master account and has no `userId`, so
 * the link is derived from the caller's own trade records: the connection that
 * actually executed their trades. A client with no trades has no connection to
 * read history from, and gets the empty response.
 */
async function resolveConnectionId(userId: string): Promise<string | null> {
  const trade = await prisma.tradeRecord.findFirst({
    where: { investment: { userId } },
    orderBy: { openedAt: 'desc' },
    select: { brokerId: true },
  });
  return trade?.brokerId ?? null;
}

/** Keep only candles whose OHLC fields are all real numbers. */
function verified(candle: Candle): boolean {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close)
  );
}

export const GET = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const url = new URL(request.url);

  const query = querySchema.parse({
    symbol: url.searchParams.get('symbol') ?? undefined,
    timeframe: url.searchParams.get('timeframe') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });

  const empty = (source: 'none' | 'unavailable') => ({
    symbol: query.symbol,
    timeframe: query.timeframe,
    candles: [] as Candle[],
    source,
  });

  const connectionId = await resolveConnectionId(user.id);
  if (!connectionId) return ok(empty('none'));

  const connection = await prisma.brokerConnection.findUnique({ where: { id: connectionId } });
  if (!connection) return ok(empty('none'));

  try {
    const adapter = await getAdapterForConnection(connection);
    await ensureBrokerConnected(adapter);
    const candles = await adapter.getHistoricalCandles(
      query.symbol,
      query.timeframe,
      query.limit,
    );

    return ok({
      symbol: query.symbol,
      timeframe: query.timeframe,
      candles: candles.filter(verified),
      source: 'broker' as const,
    });
  } catch (err) {
    // The connection exists but the broker did not answer. Report an empty
    // series and the reason; never a synthesised one.
    console.error(
      '[market/candles] broker history request failed:',
      err instanceof Error ? err.message : err,
    );
    return ok(empty('unavailable'));
  }
});
