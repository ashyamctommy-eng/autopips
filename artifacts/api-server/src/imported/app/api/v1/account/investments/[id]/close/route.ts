import { z } from 'zod';

import { ApiError, clientIp, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser } from '@/server/modules/auth/session';
import { closeInvestmentForClient } from '@/server/modules/account/maturity.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/v1/account/investments/:id/close
 *
 * Closes the caller's OWN investment, releasing its capital back to the
 * withdrawable balance.
 *
 * REFUSED while the investment still has OPEN linked positions: their floating
 * P/L would keep being counted against capital that is no longer deployed. The
 * client must let those positions close (stop-loss/take-profit or manual) first;
 * the refusal message says exactly that.
 *
 * The release itself reuses `closeInvestmentManually`, so the accounting guard,
 * the compare-and-swap and the capital-preserving patch are the same ones the
 * maturity sweep and the operator path use.
 */
export const POST = handler(async (request: Request, context: { params: { id: string } }) => {
  const user = await requireSessionUser();
  const { id } = paramsSchema.parse(context.params);

  // Closing an investment moves capital: bound how often it can be attempted.
  const limited = await rateLimit(`investment-close:user:${user.id}`, 10, 600);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many close requests. Try again in ${limited.resetSeconds}s.`);
  }

  const result = await closeInvestmentForClient({
    investmentId: id,
    userId: user.id,
    actorEmail: user.email,
    ip: clientIp(request),
  });

  return ok(result);
});
