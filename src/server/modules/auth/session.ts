import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { ACCESS_COOKIE, REFRESH_COOKIE, verifyAccessToken, isSessionRevoked } from './token.service';
import type { SessionUser } from '@/types/api';
import type { Role } from '@prisma/client';

/**
 * Request-scoped session resolution.
 *
 * Tokens are read from httpOnly cookies only. Nothing is ever read from
 * localStorage, a query string, or a request body.
 */

export interface ActiveSession {
  userId: string;
  sessionId: string;
  role: Role;
  email: string;
}

export async function getSession(): Promise<ActiveSession | null> {
  const store = cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  try {
    const claims = await verifyAccessToken(token);
    const sid = String(claims.sid ?? '');
    if (sid && (await isSessionRevoked(sid))) return null;
    return {
      userId: String(claims.sub),
      sessionId: sid,
      role: claims.role,
      email: String(claims.email ?? ''),
    };
  } catch {
    return null;
  }
}

/** Throwing variant for protected routes. */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) throw ApiError.unauthorized();
  return session;
}

export async function requireRole(...roles: Role[]): Promise<ActiveSession> {
  const session = await requireSession();
  if (!roles.includes(session.role)) throw ApiError.forbidden();
  return session;
}

export const requireAdmin = () => requireRole('ADMIN');
export const requireAdminOrManager = () => requireRole('ADMIN', 'TRADING_MANAGER');

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;
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

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw ApiError.unauthorized();
  return user;
}

/**
 * Gate for money-moving client actions. Both a live session and an APPROVED
 * KYC record are required — a client cannot deposit, invest or withdraw before
 * a human has reviewed their documents.
 */
export async function requireVerifiedClient(): Promise<SessionUser> {
  const user = await requireSessionUser();
  if (user.role === 'ADMIN' || user.role === 'TRADING_MANAGER') return user;
  if (user.kycStatus !== 'APPROVED') throw ApiError.kycRequired();
  return user;
}

/** Clear both auth cookies (logout / rotation failure). */
export function clearAuthCookies(): void {
  const store = cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    store.set(name, '', { path: '/', maxAge: 0 });
  }
}
