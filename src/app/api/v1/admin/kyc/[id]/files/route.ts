import { clientIp, handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { getKycDocumentUrls } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc/:id/files
 *
 * THE endpoint that mints pre-signed URLs for the private identity documents.
 *
 * Constraints, all enforced in ./storage.service.ts:
 *  - ADMIN only (a TRADING_MANAGER can see the queue but not the documents).
 *  - URLs live at most 300 seconds — hard cap, regardless of the request.
 *  - Nothing is public: the bucket has no public objects and no public URL is
 *    ever constructed.
 *  - Every call writes KYC_DOCUMENT_VIEWED to the audit log with the admin's
 *    id and the document kinds returned, which is the access trail for these
 *    files. A document that vanished from storage is reported as
 *    `{ kind, url: null, error }` instead of failing the whole request.
 */
export const GET = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const urls = await getKycDocumentUrls(
      context.params.id,
      session.userId,
      clientIp(request),
    );

    return ok(urls);
  },
);
