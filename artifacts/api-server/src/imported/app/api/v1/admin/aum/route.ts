import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { getAumSummary } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/aum
 *
 * Platform assets under management: managed capital, equity, open market
 * exposure, today's realised P/L, the pending-KYC backlog and the aggregate
 * ledger breakdown.
 *
 * Every figure is produced by `server/accounting/**` (getPlatformLedger,
 * getRealizedPnlToday, getOpenExposure) — this route adds no arithmetic.
 * READ-ONLY: it moves no money and writes no audit row.
 */
export const GET = handler(async () => {
  await requireAdminOrManager();
  return ok(await getAumSummary());
});
