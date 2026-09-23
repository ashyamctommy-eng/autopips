import { z } from 'zod';
import { handler, ok } from '@/lib/http';
import { requireAdminOrManager } from '@/server/modules/auth/session';
import {
  ADMIN_USER_ROLES,
  KYC_STATUS_VALUES,
  listUsers,
} from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/users?search=&role=&kycStatus=&take=&cursor=
 *
 * Cursor-paginated client/staff directory. Each row carries the user's deployed
 * capital and equity, aggregated for the whole page with `prisma.groupBy`
 * (see `aggregateUserLedgers` in admin.service.ts) — the list never issues one
 * accounting query per user.
 *
 * No credential column is selected: no passwordHash, no twoFactorSecret, no KYC
 * document keys.
 */

const querySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ADMIN_USER_ROLES).optional(),
  kycStatus: z.enum(KYC_STATUS_VALUES).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export const GET = handler(async (request: Request) => {
  await requireAdminOrManager();

  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    search: searchParams.get('search') ?? undefined,
    role: searchParams.get('role') ?? undefined,
    kycStatus: searchParams.get('kycStatus') ?? undefined,
    take: searchParams.get('take') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });

  const { items, nextCursor } = await listUsers(query);
  return ok({ items, nextCursor });
});
