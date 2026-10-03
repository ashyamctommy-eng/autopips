import { z } from 'zod';
import { handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { listAudit } from '@/server/modules/audit/audit.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/logs?action=&userId=&take=&cursor=
 *
 * The raw, append-only audit trail, newest first, with the acting user's
 * identity joined in. Unlike the activity feed on /admin/overview this returns
 * the stored rows as-is (action, details, ipAddress, timestamps) so it can back
 * an investigation, not just a feed.
 *
 * ADMIN only: audit rows contain other users' identity/money context.
 * `listAudit` caps `take` at 200.
 */

const querySchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  userId: z.string().trim().min(1).max(64).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export const GET = handler(async (request: Request) => {
  await requireAdmin();

  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    action: searchParams.get('action') ?? undefined,
    userId: searchParams.get('userId') ?? undefined,
    take: searchParams.get('take') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });

  const rows = await listAudit(query);
  return ok(rows);
});
