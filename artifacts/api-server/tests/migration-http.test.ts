import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import app from '../src/app';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('migration read boundary', () => {
  it('allows credentialed preflight requests from the production sign-in origin', async () => {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://autopips.replit.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://autopips.replit.app');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('does not reflect an unapproved origin', async () => {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('blocks cookie-authenticated mutations from unapproved origins', async () => {
    const response = await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        origin: 'https://untrusted.example',
        cookie: 'ap_at=browser-session',
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CROSS_ORIGIN_REQUEST');
  });

  it('rejects arbitrary service invocation', async () => {
    const response = await fetch(`${base}/api/migration/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'server/modules/admin/admin.service', method: 'updateUserRole', args: [] }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).ok).toBe(false);
  });
  it('rejects malformed read envelopes', async () => {
    const response = await fetch(`${base}/api/migration/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: null, method: null }),
    });
    expect(response.status).toBe(400);
  });
  it('returns no signed-in user without a cookie', async () => {
    const response = await fetch(`${base}/api/migration/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'server/modules/auth/session', method: 'getSessionUser' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: null });
  });
  it('refuses protected reads without a session', async () => {
    const response = await fetch(`${base}/api/migration/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'server/modules/account/account.service', method: 'getOverview', args: ['other-user'] }),
    });
    expect(response.status).toBe(401);
  });

  /*
   * REGRESSION — /dashboard/strategy showed "Something went wrong" for every
   * client holding capital.
   *
   * The Active Strategy Tracker (c1aa0b2) read one investment through
   * `remote('server/modules/account/account.service', 'getInvestmentForUser')`,
   * but that method was never added to the allow-list above. The SPA's page
   * awaits the read during render, so the refusal was not a quiet empty state:
   * it replaced the whole route with the group error boundary.
   *
   * The distinction asserted here is the whole point — an UNKNOWN method is
   * refused with 404 "Unknown read operation." BEFORE the session gate, so 401
   * (unauthenticated) is proof the method is allow-listed and routing correctly.
   * This test fails with 404 if the entry is ever dropped again.
   */
  it('accepts the strategy tracker read (allow-listed, then session-gated)', async () => {
    const response = await fetch(`${base}/api/migration/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        module: 'server/modules/account/account.service',
        method: 'getInvestmentForUser',
        args: ['ignored-user-id', 'ignored-investment-id'],
      }),
    });

    expect(response.status).toBe(401);
  });
});