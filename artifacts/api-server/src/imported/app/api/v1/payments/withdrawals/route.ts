import { z } from 'zod';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listWithdrawals, requestWithdrawal } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
  /** Admin-only: read every client's withdrawals. Ignored for non-staff. */
  scope: z.enum(['own', 'all']).optional(),
});

const createBodySchema = z.object({
  amountUsd: z.number().finite().positive(),
  cryptoCurrency: z.string().min(2).max(32),
  payoutAddress: z.string().min(20).max(128),
});

/** GET /api/v1/payments/withdrawals — the caller's withdrawal history. */
export const GET = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const url = new URL(request.url);
  const query = listQuerySchema.parse({
    take: url.searchParams.get('take') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    scope: url.searchParams.get('scope') ?? undefined,
  });

  const isStaff = user.role === 'ADMIN' || user.role === 'TRADING_MANAGER';
  const allUsers = query.scope === 'all' && isStaff;

  const { items, nextCursor } = await listWithdrawals(user.id, {
    take: query.take,
    cursor: query.cursor,
    allUsers,
  });

  return ok({ items, nextCursor });
});

/** POST /api/v1/payments/withdrawals — request a payout. */
export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const ip = clientIp(request);

  // Withdrawals are double-spend territory: stricter than deposits.
  const perUser = await rateLimit(`withdrawal:user:${user.id}`, 5, 600);
  if (!perUser.allowed) {
    throw ApiError.rateLimited(`Too many withdrawal requests. Try again in ${perUser.resetSeconds}s.`);
  }
  const perIp = await rateLimit(`withdrawal:ip:${ip ?? 'unknown'}`, 20, 600);
  if (!perIp.allowed) throw ApiError.rateLimited('Too many withdrawal requests from this address.');

  const body = createBodySchema.parse(await readJson(request));

  const withdrawal = await requestWithdrawal({
    user,
    amountUsd: body.amountUsd,
    cryptoCurrency: body.cryptoCurrency,
    payoutAddress: body.payoutAddress,
    ip,
  });

  return ok(withdrawal, { status: 201 });
});
