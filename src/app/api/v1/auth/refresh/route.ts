import { cookies } from 'next/headers';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAudit } from '@/server/modules/audit/audit.service';
import { clearAuthCookies } from '@/server/modules/auth/session';
import {
  REFRESH_COOKIE,
  consumeRefreshToken,
  hashRefreshToken,
  isSessionRevoked,
  revokeSession,
} from '@/server/modules/auth/token.service';
import {
  clearRefreshHash,
  issueSession,
  parseRefreshCookie,
  readRefreshHash,
  setAuthCookies,
  toSessionUser,
} from '@/server/modules/auth/session-issue';
import type { AuthLoginResponse } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/refresh
 *
 * Rotating single-use refresh.
 *
 * The presented cookie is `<sessionId>.<userId>.<token>`. Two independent
 * checks must both pass:
 *
 *   1. sha256(token) === the hash stored at rkey('refresh-store', sessionId, userId)
 *      — i.e. this is the token currently on file for that session; and
 *   2. the token has not been consumed before (SET NX in `consumeRefreshToken`).
 *
 * (1) catches a token from an earlier rotation, (2) catches two concurrent
 * presentations of the *current* token. Either one failing is a replay, and a
 * replay means the token escaped the browser: the whole session family is
 * revoked (Redis `session:<sid>:revoked`, which `getSession()` and the socket
 * handshake both honour), the stored hash is deleted and the cookies are
 * cleared. Losing the session is the point — a refresh token that exists in two
 * places cannot be trusted.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);

  const limited = await rateLimit(`refresh:ip:${ip ?? 'unknown'}`, 60, 900);
  if (!limited.allowed) {
    throw ApiError.rateLimited(`Too many token refreshes. Try again in ${limited.resetSeconds}s.`);
  }

  const raw = cookies().get(REFRESH_COOKIE)?.value;
  const parsed = parseRefreshCookie(raw);
  if (!parsed) {
    clearAuthCookies();
    throw ApiError.unauthorized('No refresh token was presented.');
  }

  const presentedHash = hashRefreshToken(parsed.token);
  const storedHash = await readRefreshHash(parsed.sessionId, parsed.userId);

  if (!storedHash || storedHash !== presentedHash) {
    await endSession(parsed.sessionId, parsed.userId, 'refresh token does not match the stored hash');
    throw ApiError.unauthorized('This session is no longer valid. Please sign in again.');
  }

  if (await isSessionRevoked(parsed.sessionId)) {
    clearAuthCookies();
    throw ApiError.unauthorized('This session has been revoked. Please sign in again.');
  }

  if (!(await consumeRefreshToken(presentedHash, parsed.sessionId))) {
    await endSession(parsed.sessionId, parsed.userId, 'refresh token was presented twice');
    throw ApiError.unauthorized('This session is no longer valid. Please sign in again.');
  }

  const user = await prisma.user.findUnique({ where: { id: parsed.userId } });
  if (!user) {
    await endSession(parsed.sessionId, parsed.userId, 'session owner no longer exists');
    throw ApiError.unauthorized('This session is no longer valid. Please sign in again.');
  }

  // Rotation: same session id (one device = one revocation handle), brand new
  // access + refresh pair, and the stored hash moved to the new token.
  const session = await issueSession(user, { sessionId: parsed.sessionId });
  setAuthCookies(session);

  await recordAudit({
    action: AUDIT.AUTH_TOKEN_REFRESHED,
    userId: user.id,
    details: { sessionId: session.sessionId },
    ipAddress: ip,
  });

  const payload: AuthLoginResponse = { user: toSessionUser(user), requires2FA: false };
  return ok(payload);
});

/** Kill a session family after detecting a token that must not be trusted. */
async function endSession(sessionId: string, userId: string, reason: string): Promise<void> {
  await revokeSession(sessionId);
  await clearRefreshHash(sessionId, userId);
  clearAuthCookies();
  console.warn(`[auth] session ${sessionId} revoked: ${reason}`);
}
