import { z } from 'zod';

import { ApiError, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSession } from '@/server/modules/auth/session';
import { disableTwoFactor } from '@/server/modules/auth/twofactor.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: z.string().trim().min(6).max(10),
});

/**
 * POST /api/v1/auth/2fa/disable
 *
 * Requires a *currently valid* code, not merely a live session: a stolen access
 * token must not be enough to strip the second factor off an account. The code
 * is verified before the secret is cleared.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireSession();

  const limited = await rateLimit(`2fa-disable:user:${session.userId}`, 10, 900);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many attempts. Try again in ${limited.resetSeconds}s.`);
  }

  const body = bodySchema.parse(await readJson(request));
  await disableTwoFactor(session.userId, body.token);

  return ok({ is2FAEnabled: false });
});
