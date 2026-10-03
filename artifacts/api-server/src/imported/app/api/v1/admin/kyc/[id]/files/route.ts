import { clientIp, handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { getKycDocumentManifest } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc/:id/files
 *
 * The review dialog's document manifest: one entry per slot, with the MIME type,
 * byte length, SHA-256 and the URL of the audited stream route.
 *
 * ADMIN only (a TRADING_MANAGER can see the queue but not the documents).
 * Opening this manifest writes KYC_DOCUMENT_VIEWED with `phase: 'manifest'`;
 * fetching a document from the URL it returns writes a second entry with
 * `phase: 'download'`. Every document is therefore accounted for twice: who asked
 * for the list, and who actually received the bytes.
 */
export const GET = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const entries = await getKycDocumentManifest(
      context.params.id,
      session.userId,
      clientIp(request),
    );

    return ok(entries);
  },
);
