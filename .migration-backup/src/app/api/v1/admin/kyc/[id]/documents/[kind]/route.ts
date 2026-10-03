import { ApiError, handler } from '@/lib/http';
import { clientIp } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { streamKycDocument } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc/:id/documents/:kind
 *
 * THE endpoint that serves an identity document to a reviewer.
 *
 * The bytes are decrypted from the platform's own Postgres on the way out — they
 * never sat in an external bucket, and this response is the only way they can
 * leave the server. There is no pre-signed URL and therefore no bearer
 * credential: this route requires a signed-in ADMIN session, is scoped to the
 * submission that owns the document, and writes KYC_DOCUMENT_VIEWED with
 * `phase: 'download'` before streaming.
 *
 * Response headers are deliberate:
 *  - `Cache-Control: private, no-store` — an identity document must not sit in a
 *    shared cache or the browser's disk cache.
 *  - `Content-Disposition: inline` with a server-derived filename — never the
 *    client's, which is not stored.
 *  - `X-Content-Type-Options: nosniff` — the browser must not re-interpret a
 *    document as anything but the MIME type we validated on upload.
 */
export const GET = handler(
  async (request: Request, context: { params: { id: string; kind: string } }) => {
    const session = await requireAdmin();

    const document = await streamKycDocument({
      profileId: context.params.id,
      kind: context.params.kind,
      adminUserId: session.userId,
      ip: clientIp(request),
    });

    if (!document) {
      throw ApiError.notFound('No document is stored in that slot for this submission.');
    }

    // Copy into a plain Uint8Array: `Buffer` is a Node type and the Response
    // constructor wants a BodyInit that is not tied to the Node Buffer class.
    const body = new Uint8Array(document.bytes);

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': document.contentType,
        'content-length': String(document.byteLength),
        'content-disposition': `inline; filename="${document.filename}"`,
        'cache-control': 'private, no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
