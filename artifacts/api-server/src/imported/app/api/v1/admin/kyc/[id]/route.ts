import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { getKycDetail, toKycDetailClientView } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc/:id
 *
 * Review detail for one submission: personal details (ID number masked),
 * document metadata for each slot and the reviewer state.
 *
 * No storage key and no document bytes are part of this payload. To look at a
 * document the reviewer calls GET /api/v1/admin/kyc/:id/files for the manifest
 * and then streams the slot from
 * GET /api/v1/admin/kyc/:id/documents/:kind — both ADMIN-only, both audited.
 */
export const GET = handler(
  async (_request: Request, context: { params: { id: string } }) => {
    // A TRADING_MANAGER may view the queue and the declared details; the
    // document routes themselves are stricter (ADMIN only).
    await requireAdminOrManager();

    const detail = await getKycDetail(context.params.id);

    return ok(toKycDetailClientView(detail));
  },
);
