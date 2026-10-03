import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { updatePlan } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/admin/plans/:id
 *
 * Partial update of a plan: only the supplied fields change, the stored plan is
 * merged with the patch and the RESULT is re-validated (so e.g. a maxInvestment
 * that would fall below the stored minInvestment is a 422, not a broken plan).
 *
 * Switching `isActive` off is audited as PLAN_DEACTIVATED; every other change as
 * PLAN_UPDATED. Raising `minInvestment` above the capital of running investments
 * is allowed (grandfathering) and the number of affected investments is written
 * into the audit details.
 */
export const PATCH = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const plan = await updatePlan(
      context.params.id,
      await readJson(request),
      session.userId,
      clientIp(request),
    );

    return ok(plan);
  },
);
