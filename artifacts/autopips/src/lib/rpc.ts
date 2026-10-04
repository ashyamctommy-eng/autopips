/**
 * Browser client for the migration RPC endpoint.
 *
 * The original Next.js server components called service modules directly. The
 * Vite build has no server, so those same read methods are invoked through
 * `POST /api/migration/query`; the API authorises every call from the session
 * cookie. Nothing from `server/` is bundled here.
 */

import { apiRequest } from '@/lib/api-request';

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

interface RpcSuccess {
  ok: true;
  data: unknown;
}
interface RpcFailure {
  ok: false;
  error: { code: string; message: string };
}

export async function rpc<T = any>(module: string, method: string, args: unknown[] = []): Promise<T> {
  let response: Response;
  try {
    response = await apiRequest('/api/migration/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, method, args }),
    });
  } catch {
    throw new RpcError('NETWORK_ERROR', 'The server could not be reached.');
  }

  let body: RpcSuccess | RpcFailure | null = null;
  try {
    body = (await response.json()) as RpcSuccess | RpcFailure;
  } catch {
    body = null;
  }

  if (!body) throw new RpcError('BAD_RESPONSE', `Unexpected response (${response.status}).`);
  if (!body.ok) throw new RpcError(body.error?.code ?? 'ERROR', body.error?.message ?? 'Request failed.');
  return body.data as T;
}

/** Build a typed-loose proxy for one service method. */
export function remote(module: string, method: string) {
  return (...args: any[]): Promise<any> => rpc(module, method, args);
}
