import { ApiError, handler, ok } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { reconcileBrokerConnection } from '@/server/modules/broker/broker.reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/brokers/:id/reconcile
 *
 * The broker-versus-ledger reconciliation report for one connection: the
 * broker's own equity and open-position count next to the ledger's deployed
 * equity and booked OPEN trades, with the drift between them.
 *
 * READ-ONLY, like the AUM route: the report itself moves no money, writes no
 * ledger row and writes no audit row, and it intentionally does NOT refresh the
 * connection snapshot (a GET must not mutate the row it is reading). The one
 * write this route can produce is the DRIFT ALERT — when a threshold is
 * breached, `reconcileBrokerConnection` records
 * `BROKER_RECONCILIATION_DRIFT` and publishes an admin activity, throttled so a
 * persistent drift does not write a row per poll.
 *
 * Open to TRADING_MANAGER as well as ADMIN: it is a read.
 */
export const GET = handler(
  async (_request: Request, context: { params: { id: string } }) => {
    await requireAdminOrManager();

    const conn = await prisma.brokerConnection.findUnique({ where: { id: context.params.id } });
    if (!conn) throw ApiError.notFound('Broker connection not found.');

    return ok(await reconcileBrokerConnection(conn));
  },
);
