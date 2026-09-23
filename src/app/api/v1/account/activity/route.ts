import { z } from 'zod';

import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listActivity } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  take: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * GET /api/v1/account/activity
 *
 * The caller's audit trail, mapped to human messages. Read from the append-only
 * audit table only: if an event is not in AuditLog it does not appear here.
 */
export const GET = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const url = new URL(request.url);

  const query = querySchema.parse({
    take: url.searchParams.get('take') ?? undefined,
  });

  const items = await listActivity(user.id, query.take ?? 50);

  return ok({ items });
});
