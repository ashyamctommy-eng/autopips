import { z } from 'zod';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser } from '@/server/modules/auth/session';
import { createDeposit, listDeposits } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
  /** Admin-only: read every client's deposits. Ignored for non-staff. */
  scope: z.enum(['own', 'all']).optional(),
});

const createBodySchema = z.object({
  amountUsd: z.number().finite().min(50).max(250_000),
  cryptoCurrency: z.string().min(2).max(32),
});

/** GET /api/v1/payments/deposits — the caller's deposit history. */
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

  const { items, nextCursor } = await listDeposits(user.id, {
    take: query.take,
    cursor: query.cursor,
    allUsers,
  });

  return ok({ items, nextCursor });
});

/** POST /api/v1/payments/deposits — create a NOWPayments payment. */
export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const ip = clientIp(request);

  // Deposit creation hits the payment provider: rate-limit it hard per user
  // (and per IP) so a script cannot mint thousands of payment addresses.
  const perUser = await rateLimit(`deposit:user:${user.id}`, 10, 300);
  if (!perUser.allowed) {
    throw ApiError.rateLimited(
      `Too many deposit attempts. Try again in ${perUser.resetSeconds}s.`,
    );
  }
  const perIp = await rateLimit(`deposit:ip:${ip ?? 'unknown'}`, 30, 300);
  if (!perIp.allowed) throw ApiError.rateLimited('Too many deposit attempts from this address.');

  const body = createBodySchema.parse(await readJson(request));

  const deposit = await createDeposit({
    user,
    amountUsd: body.amountUsd,
    cryptoCurrency: body.cryptoCurrency,
    ip,
  });

  return ok(deposit, { status: 201 });
});
