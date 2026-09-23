import { clientIp, handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { removeBrokerConnection } from '@/server/modules/broker/broker.registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/v1/admin/brokers/:id
 *
 * Deregisters a broker connection: the encrypted per-account token is deleted,
 * the cached adapter is disconnected, and the row is deleted only when it has no
 * trade history (otherwise it is kept as DISCONNECTED so archived trades still
 * point at a real broker record). The removal is audited as BROKER_DISCONNECTED.
 *
 * ADMIN only — this is the destructive half of the connection lifecycle.
 */
export const DELETE = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const result = await removeBrokerConnection(context.params.id, {
      adminUserId: session.userId,
      ip: clientIp(request),
    });

    return ok(result);
  },
);
