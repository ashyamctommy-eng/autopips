import { z } from 'zod';
import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { decideWithdrawal } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/withdrawals/:id/decision
 *
 * Body: { decision: 'APPROVE' | 'REJECT', reason?, txHash? }
 *
 * APPROVE moves the payout forward (PENDING → approved; broadcast when the
 * payout API is configured, otherwise it waits for an operator settlement whose
 * proof is recorded as `txHash`). REJECT requires a reason and is written to
 * AuditLog as WITHDRAWAL_REJECTED.
 *
 * ADMIN only: this is the single human gate that lets money leave the platform.
 * The state machine, the audit rows and the "never invent a txHash" rule all live
 * in `payments.service.decideWithdrawal`.
 */

const bodySchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().trim().max(1_000, 'Reason must be at most 1000 characters.').optional().nullable(),
    txHash: z
      .string()
      .trim()
      .min(8, 'A transaction hash must be at least 8 characters.')
      .max(200, 'A transaction hash must be at most 200 characters.')
      .optional()
      .nullable(),
  })
  .strict();

export const POST = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const body = bodySchema.parse(await readJson(request));

    const withdrawal = await decideWithdrawal({
      id: context.params.id,
      adminUserId: session.userId,
      decision: body.decision,
      reason: body.reason ?? undefined,
      txHash: body.txHash ?? undefined,
      ip: clientIp(request),
    });

    return ok(withdrawal);
  },
);
