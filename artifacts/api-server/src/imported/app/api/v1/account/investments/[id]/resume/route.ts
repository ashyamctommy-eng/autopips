import { z } from 'zod';

import { clientIp, handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { setInvestmentActiveState } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/v1/account/investments/:id/resume
 *
 * Resumes the caller's OWN investment: the engine may open NEW positions for it
 * again. Only ACTIVE ↔ PAUSED rows can move; a settled investment (MATURED,
 * CLOSED, CANCELLED) is refused. The action is audited.
 */
export const POST = handler(async (request: Request, context: { params: { id: string } }) => {
  const user = await requireSessionUser();
  const { id } = paramsSchema.parse(context.params);

  const result = await setInvestmentActiveState({
    userId: user.id,
    investmentId: id,
    target: 'ACTIVE',
    ip: clientIp(request),
  });

  return ok(result);
});
