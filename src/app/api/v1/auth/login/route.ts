import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { dummyVerify, verifyPassword } from '@/server/modules/auth/password.service';
import { issueSession, setAuthCookies, toSessionUser } from '@/server/modules/auth/session-issue';
import { issue2faChallenge } from '@/server/modules/auth/twofactor.service';
import type { AuthLoginResponse } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

/** 10 attempts per 15 minutes, applied to BOTH the IP and the email. */
const LOGIN_LIMIT = { limit: 10, windowSeconds: 900 } as const;

/** One message for every credential failure — never "no such user". */
const GENERIC_CREDENTIALS_MESSAGE = 'Invalid email or password.';

/**
 * POST /api/v1/auth/login
 *
 * Two-step by design:
 *   no 2FA → cookies are set and the session is live;
 *   with 2FA → NO cookie is issued. The response carries a single-use
 *              `challengeId` that must be exchanged, together with a valid TOTP
 *              code, at /api/v1/auth/2fa/challenge.
 *
 * A correct password alone therefore never yields a session on a 2FA account.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);
  const body = bodySchema.parse(await readJson(request));
  const email = body.email.toLowerCase().trim();

  const perIp = await rateLimit(`login:ip:${ip ?? 'unknown'}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowSeconds);
  if (!perIp.allowed) {
    throw ApiError.rateLimited(`Too many sign-in attempts. Try again in ${perIp.resetSeconds}s.`);
  }
  const perEmail = await rateLimit(`login:email:${email}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowSeconds);
  if (!perEmail.allowed) {
    throw ApiError.rateLimited(`Too many sign-in attempts. Try again in ${perEmail.resetSeconds}s.`);
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Burn equivalent CPU when the account does not exist so response time cannot
  // be used to enumerate registered addresses.
  if (!user) {
    await dummyVerify(body.password);
    await recordAuditSafe({
      action: AUDIT.AUTH_LOGIN_FAILED,
      userId: null,
      details: { email, reason: 'unknown_account' },
      ipAddress: ip,
    });
    throw ApiError.unauthorized(GENERIC_CREDENTIALS_MESSAGE);
  }

  const passwordOk = await verifyPassword(user.passwordHash, body.password);
  if (!passwordOk) {
    await recordAuditSafe({
      action: AUDIT.AUTH_LOGIN_FAILED,
      userId: user.id,
      details: { email, reason: 'bad_password' },
      ipAddress: ip,
    });
    throw ApiError.unauthorized(GENERIC_CREDENTIALS_MESSAGE);
  }

  if (user.is2FAEnabled) {
    // The pending state lives in Redis, not in a token the client could keep.
    const challengeId = await issue2faChallenge(user.id, ip);
    const payload: AuthLoginResponse = {
      user: toSessionUser(user),
      requires2FA: true,
      challengeId,
    };
    return ok(payload);
  }

  const session = await issueSession(user);
  setAuthCookies(session);

  await recordAudit({
    action: AUDIT.AUTH_LOGIN_SUCCESS,
    userId: user.id,
    details: { method: 'password', sessionId: session.sessionId },
    ipAddress: ip,
  });

  const payload: AuthLoginResponse = { user: toSessionUser(user), requires2FA: false };
  return ok(payload);
});
