import { z } from 'zod';

import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/server/modules/auth/session';
import { createInvestment } from '@/server/modules/account/account.service';
import type { SessionUser } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/investments
 *
 * Start an investment for a client — the operator-side onboarding path.
 *
 * WHY IT EXISTS: a client's own invest call requires an APPROVED KYC record, and
 * that is right: nobody should deploy their own money before a human has looked
 * at their documents. But the same rule blocks an operator from deploying funds
 * for a client whose checks were completed offline, or from setting up a funded
 * test account to watch the engine run.
 *
 * So this action does not bypass the rule quietly — it replaces the client's
 * assertion with the OPERATOR's, and writes that down:
 *   • ADMIN only;
 *   • a client whose KYC was REJECTED cannot be funded at all;
 *   • the audit row is ADMIN_INVESTMENT_CREATED, naming the operator, the reason,
 *     and the client's KYC status at the time;
 *   • plan bounds and the ledger's balance check are untouched, so no amount can
 *     be deployed that the client does not actually hold.
 */
const bodySchema = z
  .object({
    /** Client email — what an operator actually has to hand. */
    email: z.string().trim().toLowerCase().email('Enter the client account email.').max(254),
    plan_id: z.string().trim().min(1).max(64),
    amount_usd: z.number().positive('An investment must be a positive amount.').max(1_000_000),
    reason: z
      .string()
      .trim()
      .min(3, 'Give a reason — it is kept in the audit trail.')
      .max(280),
  })
  .strict();

export const POST = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = bodySchema.parse(await readJson(request));

  const target = await prisma.user.findUnique({ where: { email: body.email } });
  if (!target) throw ApiError.notFound('No account with that email address.');
  if (target.role !== 'CLIENT') {
    throw ApiError.badRequest('Investments belong to client accounts.');
  }

  // The service reads `id`, `role`, `kycStatus` from this shape — the operator's
  // session must never be substituted here, or the investment would be booked
  // against the wrong account.
  const clientUser: SessionUser = {
    id: target.id,
    email: target.email,
    fullName: target.fullName,
    role: target.role,
    kycStatus: target.kycStatus,
    is2FAEnabled: target.is2FAEnabled,
    country: target.country,
    createdAt: target.createdAt.toISOString(),
  };

  const investment = await createInvestment({
    user: clientUser,
    planId: body.plan_id,
    amountUsd: body.amount_usd,
    ip: clientIp(request),
    adminOnBehalf: {
      actorUserId: session.userId,
      actorEmail: session.email,
      reason: body.reason,
    },
  });

  return ok(investment, { status: 201 });
});
