import { handler, ok } from '@/lib/http';
import { requireSession } from '@/server/modules/auth/session';
import { SOCKET_TOKEN_TTL_SECONDS, signSocketAccessToken } from '@/server/modules/auth/session-issue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/socket-token
 *
 * A 60-second, handshake-scoped JWT for the Socket.io connection.
 *
 * Why it exists: the browser normally authenticates the WebSocket upgrade with
 * the httpOnly access cookie (the primary path — see socket-server.ts), but an
 * upgrade that crosses origins (a proxied `NEXT_PUBLIC_WS_URL`) does not always
 * carry cookies. This is the fallback for exactly that case.
 *
 * Why it is not the session token: it expires in a minute, it carries
 * `scope: 'socket'`, and it is never written to a cookie — so it cannot be used
 * as a substitute for the real session by anything that reads cookies, and the
 * stored-token replay risk of putting a long-lived JWT in JavaScript memory is
 * bounded to one handshake. The socket server still checks `isSessionRevoked`,
 * so a logged-out session cannot open a socket with one.
 */
export const GET = handler(async () => {
  const session = await requireSession();

  const token = await signSocketAccessToken({
    userId: session.userId,
    role: session.role,
    email: session.email,
    sessionId: session.sessionId,
  });

  return ok({ token, expiresIn: SOCKET_TOKEN_TTL_SECONDS });
});
