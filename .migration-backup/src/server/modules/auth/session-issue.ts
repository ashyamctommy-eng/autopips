import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { SignJWT } from 'jose';
import type { Role, User } from '@prisma/client';

import { serverEnv } from '@/lib/env';
import { redis, rkey } from '@/lib/redis';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authCookieOptions,
  generateRefreshToken,
  signAccessToken,
} from '@/server/modules/auth/token.service';
import type { SessionUser } from '@/types/api';

/**
 * Session issuance + the refresh-token revocation store.
 *
 * There is no `Session` table in prisma/schema.prisma, so the durable half of a
 * session lives in Redis:
 *
 *   ap_rt cookie  →  "<sessionId>.<userId>.<refreshToken>"
 *                    (httpOnly; the raw token is opaque `<uuid>.<uuid>`)
 *
 *   Redis key     →  rkey('refresh-store', sessionId, userId)
 *   Redis value   →  sha256(refreshToken)          ← THE REVOCATION STORE
 *   Redis TTL     →  REFRESH_TOKEN_TTL
 *
 * Only the hash is stored: the cookie is the only place the token itself exists,
 * so a Redis dump cannot be replayed as a session. The key is derived from BOTH
 * the session id and the user id, so a mismatch in either path is detectable
 * without trusting any client-supplied claim.
 *
 * Why the cookie carries the ids at all: the refresh request arrives with an
 * access token that may already be expired, so the server has no verified claims
 * to read the session/user from. The ids in the cookie are not trusted — they
 * are used to *rebuild the lookup key*, and the presented token is then compared
 * against the hash stored under it. A tampered id simply addresses a key that
 * does not exist, which reads as a replay (see the refresh route).
 *
 * The access token stays a short-lived stateless JWT; `revokeSession()` marks the
 * session revoked so `getSession()` (and the socket handshake) stops honouring it
 * even before that JWT expires.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TTL of the socket-handshake token. Long enough for one upgrade, and no more. */
export const SOCKET_TOKEN_TTL_SECONDS = 60;

type AuthzUser = Pick<User, 'id' | 'role' | 'email'>;

export interface ParsedRefreshCookie {
  sessionId: string;
  userId: string;
  token: string;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Exactly what goes into the REFRESH_COOKIE. */
  refreshCookieValue: string;
}

/** Row → wire DTO. Single mapper so every auth surface reports identically. */
export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    kycStatus: user.kycStatus,
    is2FAEnabled: user.is2FAEnabled,
    country: user.country,
    createdAt: user.createdAt.toISOString(),
  };
}

function refreshStoreKey(sessionId: string, userId: string): string {
  return rkey('refresh-store', sessionId, userId);
}

export function serialiseRefreshCookie(sessionId: string, userId: string, token: string): string {
  return `${sessionId}.${userId}.${token}`;
}

/** Returns null for anything that is not exactly the shape we wrote. */
export function parseRefreshCookie(raw: string | undefined | null): ParsedRefreshCookie | null {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 4) return null;

  const [sessionId, userId, ...rest] = parts;
  const token = rest.join('.');
  if (!sessionId || !userId || !token) return null;
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(userId)) return null;

  return { sessionId, userId, token };
}

/** Persists (or overwrites) the hash that is currently live for a session. */
export async function persistRefreshHash(
  sessionId: string,
  userId: string,
  hash: string,
): Promise<void> {
  await redis.set(refreshStoreKey(sessionId, userId), hash, 'EX', serverEnv().REFRESH_TOKEN_TTL);
}

/** The hash currently on file for a session, or null when there is none. */
export async function readRefreshHash(sessionId: string, userId: string): Promise<string | null> {
  try {
    return await redis.get(refreshStoreKey(sessionId, userId));
  } catch {
    // Redis down: treat as "unknown token" — the caller then fails closed and
    // ends the session rather than accepting an unverifiable refresh token.
    return null;
  }
}

/** Drops the stored hash (logout, replay response). */
export async function clearRefreshHash(sessionId: string, userId: string): Promise<void> {
  try {
    await redis.del(refreshStoreKey(sessionId, userId));
  } catch {
    /* best effort: the session is revoked separately */
  }
}

/**
 * Mints a full session — access JWT + opaque refresh token — and records the
 * refresh hash in the revocation store. Callers own cookie delivery so the
 * login, 2FA and refresh paths can stay visibly identical at the wire level.
 *
 * `consumeRefreshToken()` is deliberately NOT called here: consumption is a
 * *refresh-time* act. Registering the hash as consumed at issue time would make
 * the legitimate first refresh look like a replay.
 */
export async function issueSession(
  user: AuthzUser,
  options: { sessionId?: string } = {},
): Promise<IssuedSession> {
  const sessionId = options.sessionId ?? randomUUID();
  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role,
    email: user.email,
    sessionId,
  });
  const { token, hash } = generateRefreshToken();
  await persistRefreshHash(sessionId, user.id, hash);

  return {
    sessionId,
    accessToken,
    refreshToken: token,
    refreshCookieValue: serialiseRefreshCookie(sessionId, user.id, token),
  };
}

/** Writes both auth cookies. httpOnly always; Secure in production only. */
export function setAuthCookies(session: IssuedSession): void {
  const env = serverEnv();
  const store = cookies();
  store.set(ACCESS_COOKIE, session.accessToken, authCookieOptions(env.ACCESS_TOKEN_TTL));
  store.set(REFRESH_COOKIE, session.refreshCookieValue, authCookieOptions(env.REFRESH_TOKEN_TTL));
}

/**
 * Short-lived access token for the Socket.io handshake ONLY.
 *
 * The WebSocket upgrade cannot always forward cookies (a cross-origin
 * `NEXT_PUBLIC_WS_URL` proxy hop is the usual culprit), so the client may fetch
 * a token to pass in `handshake.auth`. That token:
 *
 *   • expires in 60 seconds — it is a handshake credential, not a session;
 *   • carries `scope: 'socket'` so it is distinguishable from a session token;
 *   • is signed with the same issuer/audience/algorithm as a normal access
 *     token, because the socket server verifies with `verifyAccessToken()` and
 *     checks `isSessionRevoked(sid)` — a separate audience would simply be
 *     rejected at the handshake. It is therefore never *returned* as, or
 *     substituted for, the main session cookie.
 */
export async function signSocketAccessToken(
  session: { userId: string; role: Role; email: string; sessionId: string },
  ttlSeconds = SOCKET_TOKEN_TTL_SECONDS,
): Promise<string> {
  const env = serverEnv();
  return new SignJWT({
    role: session.role,
    email: session.email,
    sid: session.sessionId,
    scope: 'socket',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(session.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}
