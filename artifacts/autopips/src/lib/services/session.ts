import { rpc, RpcError } from '@/lib/rpc';
import { redirect } from '@/lib/next/navigation';
import type { SessionUser } from '@/types/api';

const MODULE = 'server/modules/auth/session';

/** The signed-in user, or null for an anonymous visitor. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    return await rpc<SessionUser | null>(MODULE, 'getSessionUser');
  } catch (error) {
    if (error instanceof RpcError && error.code === 'UNAUTHORIZED') return null;
    throw error;
  }
}

/**
 * Like the server original, an anonymous visitor cannot continue. The server
 * threw 401 and the edge middleware sent the visitor to sign in; here that
 * becomes a redirect to /login (the router adds the `next` parameter).
 */
export async function requireSessionUser(): Promise<SessionUser> {
  try {
    return await rpc<SessionUser>(MODULE, 'requireSessionUser');
  } catch (error) {
    if (error instanceof RpcError && error.code === 'UNAUTHORIZED') redirect('/login');
    throw error;
  }
}
