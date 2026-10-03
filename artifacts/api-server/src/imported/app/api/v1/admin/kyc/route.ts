import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import { listKycQueue } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/kyc?status=&take=&cursor=
 *
 * FIFO review queue (oldest submission first). Admins and trading managers can
 * see the queue; only an ADMIN can open the documents themselves.
 */
export const GET = handler(async (request: Request) => {
  await requireAdminOrManager();

  const { searchParams } = new URL(request.url);

  const rows = await listKycQueue({
    status: searchParams.get('status') ?? undefined,
    take: searchParams.get('take') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });

  return ok(rows);
});
