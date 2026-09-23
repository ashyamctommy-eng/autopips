import { cookies } from 'next/headers';

import { clientIp, handler, ok } from '@/lib/http';
import { AUDIT, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { clearAuthCookies, getSession } from '@/server/modules/auth/session';
import { REFRESH_COOKIE, hashRefreshToken, revokeSession } from '@/server/modules/auth/token.service';
import {
  clearRefreshHash,
  parseRefreshCookie,
  readRefreshHash,
} from '@/server/modules/auth/session-issue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/logout
 *
 * Idempotent by design: it returns 200 whether or not there was a live session,
 * so a client can call it unconditionally (including after its access token has
 * already expired) without having to special-case a 401.
 *
 * Both halves of the session die: the Redis revocation marker (which invalidates
 * the still-valid access JWT within its remaining lifetime) and the stored
 * refresh hash (so no rotation can resurrect it). Cookies are always cleared.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);
  const session = await getSession();

  if (session) {
    await revokeSession(session.sessionId);
    await clearRefreshHash(session.sessionId, session.userId);
    await recordAuditSafe({
      action: AUDIT.AUTH_LOGOUT,
      userId: session.userId,
      details: { sessionId: session.sessionId },
      ipAddress: ip,
    });
  } else {
    // No usable access token (expired or already gone) — fall back to the
    // refresh cookie so an expired session can still be torn down. The cookie is
    // only acted on when its token matches the stored hash, so this cannot be
    // used to revoke someone else's session from an unauthenticated request.
    const parsed = parseRefreshCookie(cookies().get(REFRESH_COOKIE)?.value);
    if (parsed) {
      const storedHash = await readRefreshHash(parsed.sessionId, parsed.userId);
      if (storedHash && storedHash === hashRefreshToken(parsed.token)) {
        await revokeSession(parsed.sessionId);
        await clearRefreshHash(parsed.sessionId, parsed.userId);
        await recordAuditSafe({
          action: AUDIT.AUTH_LOGOUT,
          userId: parsed.userId,
          details: { sessionId: parsed.sessionId, via: 'refresh_cookie' },
          ipAddress: ip,
        });
      }
    }
  }

  clearAuthCookies();
  return ok({ loggedOut: true });
});
