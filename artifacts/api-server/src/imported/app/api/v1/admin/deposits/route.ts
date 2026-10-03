import { z } from 'zod';

import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { requireAdmin, requireAdminOrManager } from '@/server/modules/auth/session';
import { PAYMENT_STATUS_VALUES } from '@/server/modules/admin/admin.service';
import { adminCreditDeposit, adminListDeposits } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/v1/admin/deposits   — platform-wide deposit list, newest first.
 *                                 `?status=&userId=&take=&cursor=`
 * POST /api/v1/admin/deposits   — credit a client's balance by hand (ADMIN).
 *
 * The list is readable by a TRADING_MANAGER (the same audience as the payout
 * queue); the credit is ADMIN-only, because it creates money in the ledger and
 * the audit row names the operator who did it.
 *
 * A manual credit is NOT a payment: see `adminCreditDeposit`. It is stored with
 * a `manual:` payment id, so it can never be reconciled against a provider, and
 * it is audited as ADMIN_DEPOSIT_CREDITED rather than DEPOSIT_CONFIRMED.
 */
const querySchema = z.object({
  status: z.enum(PAYMENT_STATUS_VALUES).optional(),
  userId: z.string().trim().min(1).max(64).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export const GET = handler(async (request: Request) => {
  await requireAdminOrManager();

  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    status: searchParams.get('status') ?? undefined,
    userId: searchParams.get('userId') ?? undefined,
    take: searchParams.get('take') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });

  return ok(await adminListDeposits(query));
});

const creditSchema = z
  .object({
    /** Client email — what an operator actually has to hand. */
    email: z.string().trim().toLowerCase().email('Enter the client account email.').max(254),
    amount_usd: z.number().positive('A credit must be a positive amount.').max(1_000_000),
    note: z
      .string()
      .trim()
      .min(3, 'Give a reason — it is kept in the audit trail.')
      .max(280),
  })
  .strict();

export const POST = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = creditSchema.parse(await readJson(request));

  const user = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true },
  });
  if (!user) throw ApiError.notFound('No account with that email address.');

  const deposit = await adminCreditDeposit({
    userId: user.id,
    amountUsd: body.amount_usd,
    note: body.note,
    adminUserId: session.userId,
    adminEmail: session.email,
    ip: clientIp(request),
  });

  return ok(deposit, { status: 201 });
});
