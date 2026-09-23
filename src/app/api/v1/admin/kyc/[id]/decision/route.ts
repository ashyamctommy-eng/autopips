import { z } from 'zod';
import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { KYC_DECISIONS, decideKyc } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/kyc/:id/decision
 *
 * Body: { decision: 'APPROVE' | 'REJECT' | 'REQUEST_MORE_INFO', rejectionReason? }
 *
 * REJECT and REQUEST_MORE_INFO require a reason. The profile status and the
 * user's kycStatus move together in one transaction, and the decision is written
 * to AuditLog (KYC_APPROVED / KYC_REJECTED / KYC_ADDITIONAL_INFO_REQUESTED).
 */

const bodySchema = z.object({
  decision: z.enum(KYC_DECISIONS),
  rejectionReason: z.string().trim().max(1000).optional().nullable(),
});

export const POST = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const body = bodySchema.parse(await readJson(request));

    const profile = await decideKyc({
      id: context.params.id,
      adminUserId: session.userId,
      decision: body.decision,
      rejectionReason: body.rejectionReason ?? null,
      ip: clientIp(request),
    });

    return ok(profile);
  },
);
