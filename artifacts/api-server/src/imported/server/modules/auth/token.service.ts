import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { serverEnv } from '@/lib/env';
import { redis, rkey } from '@/lib/redis';
import { randomUUID, createHash } from 'node:crypto';
import type { Role } from '@prisma/client';

/**
 * Session + JWT handling.
 *
 * Access tokens are short-lived stateless JWTs (HS256, server-only secret).
 * Refresh tokens are opaque random strings whose SHA-256 is the only thing
 * persisted — a database leak therefore cannot be replayed as a session.
 * Refresh rotation is single-use and tracked in Redis for instant revocation.
 *
 * The JWT never carries secrets and is never written to localStorage on the
 * client: the browser holds it in an httpOnly, SameSite=Lax cookie.
 */

export const ACCESS_COOKIE = 'ap_at';
export const REFRESH_COOKIE = 'ap_rt';
export const CSRF_COOKIE = 'ap_csrf';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: Role;
  email: string;
  /** Session id — lets an admin revoke a single device. */
  sid: string;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(serverEnv().JWT_SECRET);
}

export async function signAccessToken(claims: {
  userId: string;
  role: Role;
  email: string;
  sessionId: string;
}): Promise<string> {
  const env = serverEnv();
  return new SignJWT({ role: claims.role, email: claims.email, sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const env = serverEnv();
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (!payload.sub) throw new Error('Access token is missing a subject.');
  return payload as AccessTokenClaims;
}

/** Opaque refresh token. Only its hash is ever stored. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = `${randomUUID()}.${randomUUID()}`;
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mark the presented refresh hash as consumed. Returns false if it was already
 * used or revoked, which signals a replayed token: the caller must then revoke
 * the whole session family.
 */
export async function consumeRefreshToken(hash: string, sessionId: string): Promise<boolean> {
  const env = serverEnv();
  const key = rkey('refresh', sessionId, hash);
  const res = await redis.set(key, '1', 'EX', env.REFRESH_TOKEN_TTL, 'NX');
  return res === 'OK';
}

export async function revokeSession(sessionId: string): Promise<void> {
  await redis.set(rkey('session', sessionId, 'revoked'), '1', 'EX', serverEnv().REFRESH_TOKEN_TTL);
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await redis.exists(rkey('session', sessionId, 'revoked'))) === 1;
  } catch {
    // Redis down → treat sessions as valid rather than locking out every user,
    // but access tokens are short-lived so the blast radius is bounded.
    return false;
  }
}

/** Cookie options for the auth cookies. Secure in production only. */
export function authCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: serverEnv().NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
