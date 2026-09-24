import { z } from 'zod';

import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { getPublicCandles } from '@/server/modules/market/public-market.service';
import type { Candle } from '@/server/modules/broker/broker.types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/market/candles?symbol=frxXAUUSD&timeframe=1h&limit=300
 *
 * Historical candles from Deriv's PUBLIC market feed, for an authenticated
 * client. Prices are public: they never needed an account, and this route no
 * longer pretends they do.
 *
 * It used to read through the broker connection behind the caller's own trades,
 * so a client with no trades got `source: 'none'` and an empty chart — while the
 * broker had the data the whole time. Only ACCOUNT data (balance, positions,
 * orders) requires a registered connection.
 *
 * ZERO FABRICATION is unchanged: one source, every bar off the wire, unusable
 * bars dropped rather than repaired. A failure yields an EMPTY array, never a
 * synthesised series.
 *
 * The response is `{ symbol, timeframe, candles, source }`, where `source` is:
 *   'broker'      — the feed answered (an instrument with no history in the
 *                   requested window is legitimately empty);
 *   'unavailable' — the market-data feed could not be reached.
 */

/** Symbols the bridge can be asked for: letters, digits and common separators. */
const SYMBOL_PATTERN = /^[A-Z0-9._#+-]{2,24}$/;

/**
 * Timeframes the Deriv history endpoint accepts. Anything else is rejected
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

  const empty = (source: 'unavailable') => ({
    symbol: query.symbol,
    timeframe: query.timeframe,
    candles: [] as Candle[],
    source,
  });

  // `user` is read for the authentication boundary only: market data is public,
  // but an anonymous caller has no reason to consume this platform's feed.
  void user;

  try {
    const candles = await getPublicCandles(query.symbol, query.timeframe, query.limit);

    return ok({
      symbol: query.symbol,
      timeframe: query.timeframe,
      candles: candles.filter(verified),
      source: 'broker' as const,
    });
  } catch (err) {
    // The feed did not answer. Report an empty series and the reason; never a
    // synthesised one.
    console.error(
      '[market/candles] market-data request failed:',
      err instanceof Error ? err.message : err,
    );
    return ok(empty('unavailable'));
  }
});
