import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { getAdminOverview } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/overview
 *
 * The admin landing screen in ONE round trip:
 *   aum            — AUM summary (platform ledger + exposure + pending KYC)
 *   pendingKycCount— the KYC review backlog (mirrors aum.pendingKycCount)
 *   recentActivity — last 25 audit events as the activity feed
 *   brokers        — broker connections WITHOUT latency probing (cheap; probe
 *                    a single connection via /admin/brokers/:id/status)
 *   tradingStats   — verified platform-wide trade statistics, or null when the
 *                    platform has no closed trades yet
 *
 * READ-ONLY. Available to ADMIN and TRADING_MANAGER.
 */
export const GET = handler(async () => {
  await requireAdminOrManager();
  return ok(await getAdminOverview());
});
