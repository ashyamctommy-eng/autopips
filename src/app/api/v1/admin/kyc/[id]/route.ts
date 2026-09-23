import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { getKycDetail, toKycDetailClientView } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc/:id
 *
 * Review detail for one submission: personal details (ID number masked),
 * presence flags for each document and the reviewer state.
 *
 * The raw private-bucket object keys stay on the server — to look at a document
 * the reviewer calls GET /api/v1/admin/kyc/:id/files, which mints 300-second
 * signed URLs and records the access in AuditLog.
 */
export const GET = handler(
  async (_request: Request, context: { params: { id: string } }) => {
    const session = await requireAdminOrManager();

    const detail = await getKycDetail(context.params.id, session.role);

    return ok(toKycDetailClientView(detail));
  },
);
