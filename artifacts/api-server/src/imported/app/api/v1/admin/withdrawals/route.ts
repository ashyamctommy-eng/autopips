import { z } from 'zod';
import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { PAYMENT_STATUS_VALUES } from '@/server/modules/admin/admin.service';
import { adminListWithdrawals } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/withdrawals?status=&take=&cursor=
 *
 * Platform-wide payout queue, newest first. Rows expose the amount, the payout
 * address, the fee and the txHash (null until a settlement is actually
 * broadcast) — nothing else about the client's account.
 *
 * `status` maps to Prisma's PaymentStatus. NOTE (payments module contract): an
 * APPROVED withdrawal is stored as SENDING and a REJECTED one as FAILED; the
 * decision reason lives in the WITHDRAWAL_REJECTED audit row.
 */

const querySchema = z.object({
  status: z.enum(PAYMENT_STATUS_VALUES).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export const GET = handler(async (request: Request) => {
  await requireAdminOrManager();

  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    status: searchParams.get('status') ?? undefined,
    take: searchParams.get('take') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });

  const { items, nextCursor } = await adminListWithdrawals(query);
  return ok({ items, nextCursor });
});
