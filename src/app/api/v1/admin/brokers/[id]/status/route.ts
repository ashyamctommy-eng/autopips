import { handler, ok } from '@/lib/http';
import { requireAdmin, requireAdminOrManager } from '@/server/modules/auth/session';
import {
  getBrokerConnection,
  probeBrokerLatency,
  syncBrokerById,
} from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/v1/admin/brokers/:id/status — live latency probe + stored snapshot
 * POST /api/v1/admin/brokers/:id/status — force one synchronization cycle
 *
 * GET performs a REAL probe (`adapter.ping()` → MetaApi `getServerTime`) and
 * records the broker-reported state via `updateBrokerSnapshot`, then returns the
 * refreshed connection row. `latencyMs` is null when the probe could not
 * complete; no latency figure is ever estimated.
 *
 * POST runs the same cycle the background worker runs — account snapshot, open
 * positions, closing deals, investment roll-ups — and returns its summary
 * counters. Triggering it is a write (it can create/close TradeRecord rows), so
 * it is ADMIN-only; the read probe is open to TRADING_MANAGER too.
 */
export const GET = handler(
  async (_request: Request, context: { params: { id: string } }) => {
    await requireAdminOrManager();

    const probe = await probeBrokerLatency(context.params.id);
    const connection = await getBrokerConnection(context.params.id);

    return ok({ ...probe, connection });
  },
);

export const POST = handler(
  async (_request: Request, context: { params: { id: string } }) => {
    await requireAdmin();

    const result = await syncBrokerById(context.params.id);
    const connection = await getBrokerConnection(context.params.id);

    return ok({ ...result, connection });
  },
);
