import { z } from 'zod';

import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listTrades } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

/** GET /api/v1/account/trades — cursor-paginated trade history, newest first. */
export const GET = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const url = new URL(request.url);

  const query = querySchema.parse({
    status: url.searchParams.get('status') ?? undefined,
    take: url.searchParams.get('take') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });

  const page = await listTrades(user.id, query);

  return ok(page);
});
