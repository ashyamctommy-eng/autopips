import { z } from 'zod';
import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { reconcileDeposit } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/v1/payments/deposits/[id]
 *
 * Returns one deposit scoped to its owner (staff may read any). While the
 * deposit is still PENDING it polls NOWPayments and reconciles the row, so a
 * client watching the checkout page sees it settle even if the IPN is delayed.
 */
export const GET = handler(async (request: Request, context: { params: { id: string } }) => {
  const user = await requireSessionUser();
  const { id } = paramsSchema.parse(context.params);

  const isStaff = user.role === 'ADMIN' || user.role === 'TRADING_MANAGER';
  const deposit = await reconcileDeposit(user.id, id, { allUsers: isStaff });

  return ok({ deposit });
});
