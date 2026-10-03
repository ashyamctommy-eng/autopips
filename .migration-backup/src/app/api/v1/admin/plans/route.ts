import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { createPlan, listPlans } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/v1/admin/plans      — every plan, with live strategy stats
 *                                 (`?stats=0` skips the stats computation).
 * POST /api/v1/admin/plans      — create a plan (PLAN_CREATED audit row).
 *
 * ADMIN only: a plan defines the capital tiers, fees and the drawdown stop the
 * bot engine enforces, so it is not a manager-editable surface.
 *
 * Input validation lives in `admin/plan-validation.ts` and is applied by
 * `createPlan` itself, so the contract holds for every caller.
 */
export const GET = handler(async (request: Request) => {
  await requireAdmin();

  const { searchParams } = new URL(request.url);
  const includeStats = searchParams.get('stats') !== '0';

  return ok(await listPlans({ includeStats }));
});

export const POST = handler(async (request: Request) => {
  const session = await requireAdmin();

  const plan = await createPlan(await readJson(request), session.userId, clientIp(request));

  return ok(plan, { status: 201 });
});
