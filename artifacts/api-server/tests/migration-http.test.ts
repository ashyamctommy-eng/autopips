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
});