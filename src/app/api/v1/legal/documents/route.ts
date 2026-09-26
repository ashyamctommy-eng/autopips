import { handler, ok } from '@/lib/http';
import { currentLegalDocuments } from '@/server/modules/legal/legal.documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/legal/documents
 *
 * The legal instruments currently in force, with their version and content hash.
 * Public on purpose: a client (or a regulator, or the register form) can see
 * exactly which version is live without an account. The paragraph bodies are NOT
 * returned here — each document is served as a page at its own `url` — so this
 * endpoint stays a small, cacheable index.
 */
export const GET = handler(async () => {
  const documents = currentLegalDocuments().map((doc) => ({
    type: doc.type,
    version: doc.version,
    title: doc.title,
    url: doc.url,
    effectiveFrom: doc.effectiveFrom,
    contentHash: doc.contentHash,
  }));

  return ok({ documents });
});
