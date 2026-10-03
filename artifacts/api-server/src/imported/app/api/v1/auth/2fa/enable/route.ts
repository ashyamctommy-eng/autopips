import { z } from 'zod';

import { ApiError, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSession } from '@/server/modules/auth/session';
import { enableTwoFactor } from '@/server/modules/auth/twofactor.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** The secret handed out by GET /api/v1/auth/2fa/setup. */
  secret: z.string().trim().min(16).max(64),
  token: z.string().trim().min(6).max(10),
});

/**
 * POST /api/v1/auth/2fa/enable
 *
 * Confirms enrolment. The confirming code is verified BEFORE anything is
 * written (see enableTwoFactor): an account is never left with a secret its
 * authenticator has not proved it can reproduce.
 */
export const POST = handler(async (request: Request) => {
  const session = await requireSession();

  const limited = await rateLimit(`2fa-enable:user:${session.userId}`, 10, 900);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many attempts. Try again in ${limited.resetSeconds}s.`);
  }

  const body = bodySchema.parse(await readJson(request));
  await enableTwoFactor(session.userId, body.secret, body.token);

  return ok({ is2FAEnabled: true });
});
