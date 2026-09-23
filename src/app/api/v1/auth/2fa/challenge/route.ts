import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { issueSession, setAuthCookies, toSessionUser } from '@/server/modules/auth/session-issue';
import { consume2faChallenge, verifyTotp } from '@/server/modules/auth/twofactor.service';
import type { AuthLoginResponse } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  challengeId: z.string().uuid(),
  token: z.string().trim().min(6).max(10),
});

/** Second-factor attempts per IP: a 6-digit space must not be walkable. */
const CHALLENGE_LIMIT = { limit: 20, windowSeconds: 900 } as const;

/**
 * POST /api/v1/auth/2fa/challenge
 *
 * Step two of a 2FA login. It is reachable ONLY with a challenge id that
 * `/auth/login` minted after a correct password.
 *
 * The challenge is consumed (GETDEL in Redis) BEFORE the code is checked, so a
 * challenge is strictly single-use: a wrong code cannot be retried against the
 * same challenge, and a replayed challengeId is indistinguishable from an
 * expired one. On success this route behaves exactly like a password login:
 * both cookies are set and the session is live.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);

  const limited = await rateLimit(`2fa:ip:${ip ?? 'unknown'}`, CHALLENGE_LIMIT.limit, CHALLENGE_LIMIT.windowSeconds);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many verification attempts. Try again in ${limited.resetSeconds}s.`);
  }

  const body = bodySchema.parse(await readJson(request));

  const userId = await consume2faChallenge(body.challengeId);
  if (!userId) {
    throw ApiError.unauthorized('That two-factor request has expired or was already used. Please sign in again.');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.is2FAEnabled || !user.twoFactorSecret) {
    // The account changed between password and code (2FA disabled, deleted, or
    // the secret rotated). There is nothing valid to verify against.
    await recordAuditSafe({
      action: AUDIT.AUTH_2FA_CHALLENGE_FAILED,
      userId,
      details: { reason: 'no_active_secret' },
      ipAddress: ip,
    });
    throw ApiError.unauthorized('Two-factor authentication is no longer active for this account. Please sign in again.');
  }

  if (!verifyTotp(user.twoFactorSecret, body.token)) {
    await recordAuditSafe({
      action: AUDIT.AUTH_2FA_CHALLENGE_FAILED,
      userId: user.id,
      details: { reason: 'invalid_code' },
      ipAddress: ip,
    });
    throw ApiError.unauthorized('Invalid authentication code.');
  }

  const session = await issueSession(user);
  setAuthCookies(session);

  await recordAudit({
    action: AUDIT.AUTH_LOGIN_SUCCESS,
    userId: user.id,
    details: { method: 'password+totp', sessionId: session.sessionId },
    ipAddress: ip,
  });

  const payload: AuthLoginResponse = { user: toSessionUser(user), requires2FA: false };
  return ok(payload);
});
