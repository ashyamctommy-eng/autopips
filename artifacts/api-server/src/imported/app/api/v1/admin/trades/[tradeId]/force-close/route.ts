import { clientIp, handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { forceCloseTrade } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/trades/:tradeId/force-close
 *
 * Sends a real close request to the broker for a booked, OPEN trade and settles
 * the row through the same path the periodic sync uses.
 *
 * Two honest outcomes, because they are genuinely different:
 *   • `closedAtBroker: true, settled: false` — the broker closed the contract but
 *     the ledger refuses to book the result (e.g. a contract-broker position with
 *     no lot size, whose exposure model is still undecided). The row is left for
 *     the sync rather than written with a made-up size, and the operator is told.
 *   • `closedAtBroker: false` — the broker rejected the close; nothing changed.
 *
 * A non-OPEN trade is a 409, not a silent no-op.
 */
export const POST = handler(async (request: Request, context: { params: { tradeId: string } }) => {
  const session = await requireAdmin();

  const result = await forceCloseTrade({
    tradeId: context.params.tradeId,
    actorId: session.userId,
    ip: clientIp(request),
  });

  return ok(result);
});
