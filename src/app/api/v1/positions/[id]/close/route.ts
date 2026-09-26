import { z } from 'zod';

import { ApiError, clientIp, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireVerifiedClient } from '@/server/modules/auth/session';
import {
  closePosition,
  isInternalExecutionEnabled,
} from '@/server/modules/positions/position.service';
import { getLatestPrice } from '@/server/modules/market/public-market.service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/v1/positions/[id]/close
 *
 * Closes the caller's OPEN position at the CURRENT market price. The fill is
 * resolved server-side for the same reason the open is: a client-supplied close
 * price is a client-supplied profit.
 *
 * Stop-loss / take-profit fills are applied by the tick engine; this route is the
 * manual close path only, so a protective order cannot be bypassed by racing a
 * manual close at a better price (the compare-and-swap in the service decides —
 * whichever transition lands first wins).
 */
export const POST = handler(async (request: Request, context: { params: { id: string } }) => {
  const user = await requireVerifiedClient();
  const ip = clientIp(request);
  const { id } = paramsSchema.parse(context.params);

  const limited = await rateLimit(`position-close:user:${user.id}`, 30, 600);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many close requests. Try again in ${limited.resetSeconds}s.`);
  }

  if (!isInternalExecutionEnabled()) {
    throw ApiError.forbidden(
      'Internal execution is disabled on this deployment (EXECUTION_MODE is not "internal").',
    );
  }

  const row = await prisma.position.findFirst({
    where: { id, userId: user.id },
    select: { symbol: true, status: true },
  });
  if (!row) throw ApiError.notFound('Position not found.');
  if (row.status !== 'OPEN') {
    throw ApiError.conflict(`Only an OPEN position can be closed (current status: ${row.status}).`);
  }

  const price = await getLatestPrice(row.symbol);
  if (price === null) {
    throw ApiError.serviceUnavailable(
      `The price feed returned no usable price for ${row.symbol}. The position was not closed.`,
    );
  }

  const closed = await closePosition({ userId: user.id, positionId: id, price, reason: 'MANUAL', ip });
  return ok(closed);
});
