import { z } from 'zod';

import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';
import { requireSessionUser } from '@/server/modules/auth/session';
import { createInvestment, listInvestments } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createBodySchema = z.object({
  planId: z.string().uuid(),
  amountUsd: z.number().finite().positive(),
});

/** GET /api/v1/account/investments — the caller's positions in the plans. */
export const GET = handler(async () => {
  const user = await requireSessionUser();
  const items = await listInvestments(user.id);

  return ok({ items }, { disclaimer: TARGET_RETURN_DISCLAIMER });
});

/**
 * POST /api/v1/account/investments
 *
 * Deploys part of the caller's withdrawable balance into a plan.
 *
 * Gated on APPROVED KYC (inside the service, so the rule holds for every caller)
 * and on the ledger's own withdrawable balance — capital already deployed cannot
 * be deployed twice.
 */
export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const ip = clientIp(request);

  // Capital deployment is a money action: bound how often it can be attempted.
  const limited = await rateLimit(`investment:user:${user.id}`, 10, 600);
  if (!limited.allowed) {
    throw ApiError.rateLimited(
      `Too many investment attempts. Try again in ${limited.resetSeconds}s.`,
    );
  }

  const body = createBodySchema.parse(await readJson(request));

  const investment = await createInvestment({
    user,
    planId: body.planId,
    amountUsd: body.amountUsd,
    ip,
  });

  return ok(investment, { status: 201, disclaimer: TARGET_RETURN_DISCLAIMER });
});
