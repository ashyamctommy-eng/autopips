import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listPositions } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/account/positions
 *
 * Live and historical positions. `items` is OPEN-first; `open` and `closed` are
 * the same objects split for callers that render two tables, so neither the
 * client nor the server needs a second query to show them separately.
 *
 * An OPEN position reports `currentPrice: null` and its floating P/L only when
 * the broker sync has recorded one — there is no fallback to the entry price and
 * no derived estimate.
 */
export const GET = handler(async () => {
  const user = await requireSessionUser();
  const items = await listPositions(user.id);

  return ok({
    items,
    open: items.filter((position) => position.status === 'OPEN'),
    closed: items.filter((position) => position.status !== 'OPEN'),
  });
});
