import { z } from 'zod';

import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser, requireVerifiedClient } from '@/server/modules/auth/session';
import {
  listPositions,
  openPosition,
  POSITION_MAX_MULTIPLIER,
  POSITION_MAX_STAKE_USD,
} from '@/server/modules/positions/position.service';
import { getLatestPrice } from '@/server/modules/market/public-market.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POSITION_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED', 'ALL'] as const;

const openBodySchema = z.object({
  symbol: z.string().trim().min(2).max(24),
  side: z.enum(['BUY', 'SELL']),
  stakeUsd: z.number().finite().positive().max(POSITION_MAX_STAKE_USD),
  multiplier: z.number().finite().positive().max(POSITION_MAX_MULTIPLIER).optional(),
  stopLoss: z.number().finite().positive().optional(),
  takeProfit: z.number().finite().positive().optional(),
});

/**
 * GET /api/v1/positions — the caller's internally-executed positions.
 *
 * POST /api/v1/positions — open one.
 *
 * There is deliberately NO `entryPrice` in the request body: the server prices
 * the fill from the market feed (`getLatestPrice`). Letting a client choose its
 * own entry is the difference between a trading engine and a money printer.
 *
 * Gated on APPROVED KYC and on the ledger's withdrawable balance — the stake is
 * reserved out of idle cash and becomes deployed capital (there is no separate
 * balance column to keep in step).
 */
export const GET = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const url = new URL(request.url);

  const rawStatus = (url.searchParams.get('status') ?? 'ALL').toUpperCase();
  const status = (POSITION_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as (typeof POSITION_STATUSES)[number])
    : 'ALL';

  const rawTake = Number(url.searchParams.get('take') ?? 25);
  const take = Number.isFinite(rawTake) ? rawTake : 25;
  const cursor = url.searchParams.get('cursor');

  const page = await listPositions(user.id, { status, take, cursor });
  return ok(page);
});

export const POST = handler(async (request: Request) => {
  // Verified identity: opening a position commits real money from the wallet.
  const user = await requireVerifiedClient();
  const ip = clientIp(request);

  const limited = await rateLimit(`position:user:${user.id}`, 20, 600);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many position requests. Try again in ${limited.resetSeconds}s.`);
  }

  const body = openBodySchema.parse(await readJson(request));

  const entryPrice = await getLatestPrice(body.symbol);
  if (entryPrice === null) {
    throw ApiError.serviceUnavailable(
      `The price feed returned no usable price for ${body.symbol}. The position was not opened.`,
    );
  }

  const position = await openPosition({
    userId: user.id,
    symbol: body.symbol,
    side: body.side,
    stakeUsd: body.stakeUsd,
    multiplier: body.multiplier,
    entryPrice,
    stopLoss: body.stopLoss ?? null,
    takeProfit: body.takeProfit ?? null,
    ip,
  });

  return ok(position, { status: 201 });
});
