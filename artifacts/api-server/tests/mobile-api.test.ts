import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { requestContext } from '../src/imported/lib/request-context';
const mocks = vi.hoisted(() => ({
  session: vi.fn(), snapshot: vi.fn(), positions: vi.fn(), activity: vi.fn(),
}));
vi.mock('../src/imported/server/modules/auth/session', () => ({ requireSessionUser: mocks.session }));
vi.mock('../src/imported/server/accounting/ledger', () => ({ getAccountSnapshot: mocks.snapshot }));
vi.mock('../src/imported/server/modules/positions/position.service', () => ({ listPositions: mocks.positions }));
vi.mock('../src/imported/server/modules/account/account.service', () => ({
  listActivity: mocks.activity, listPositions: vi.fn(),
}));
vi.mock('../src/imported/lib/env', () => ({ serverEnv: () => ({ EXECUTION_MODE: 'internal' }) }));
vi.mock('../src/imported/server/modules/auth/token.service', () => ({ ACCESS_COOKIE: 'ap_at', REFRESH_COOKIE: 'ap_rt' }));
vi.mock('../src/imported/app/api/v1/auth/login/route', () => ({
  POST: async () => {
    requestContext.getStore()!.res.cookie('ap_at', 'issued-access');
    requestContext.getStore()!.res.cookie('ap_rt', 'issued-refresh');
    return Response.json({ ok: true, data: { requires2FA: false } });
  },
}));
vi.mock('../src/imported/app/api/v1/auth/2fa/challenge/route', () => ({
  POST: async () => Response.json({ ok: false, error: { message: 'Invalid code' } }, { status: 401 }),
}));
vi.mock('../src/imported/app/api/v1/auth/refresh/route', () => ({
  POST: async () => Response.json({ ok: false }, { status: 401 }),
}));
vi.mock('../src/imported/app/api/v1/auth/logout/route', () => ({
  POST: async () => Response.json({ ok: true, data: { loggedOut: true } }),
}));
import router from '../src/mobile-api';
let server: Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  base = `http://127.0.0.1:${address.port}/api/mobile`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
describe('mobile companion boundary', () => {
  it('requires the original authenticated user and ignores browser cookies', async () => {
    mocks.session.mockImplementation(async () => {
      expect(requestContext.getStore()!.req.cookies).toEqual({});
      throw { status: 401, message: 'Authentication required.' };
    });
    const res = await fetch(`${base}/account`, { headers: { cookie: 'ap_at=browser-session' } });
    expect(res.status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('reads only the session owner and serializes ledger decimals without arithmetic', async () => {
    mocks.session.mockImplementation(async () => {
      expect(requestContext.getStore()!.req.cookies).toEqual({ ap_at: 'verified-by-session-service' });
      return { id: 'owner', fullName: 'Client', email: 'client@example.test', kycStatus: 'APPROVED' };
    });
    const decimal = { toFixed: () => '9007199254740993.12' };
    mocks.snapshot.mockResolvedValue({ withdrawableBalance: decimal, activeCapital: decimal, pendingWithdrawals: decimal, breakdown: { equity: decimal } });
    mocks.positions.mockResolvedValue({ items: [], nextCursor: null });
    mocks.activity.mockResolvedValue([]);
    const res = await fetch(`${base}/account?userId=someone-else`, { headers: { authorization: 'Bearer verified-by-session-service' } });
    expect(res.status).toBe(200);
    expect((await res.json()).wallet.equityUsd).toBe('9007199254740993.12');
    expect(mocks.snapshot).toHaveBeenCalledWith('owner');
    expect(mocks.positions).toHaveBeenCalledWith('owner', { take: 25, cursor: undefined });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('adapts original session cookies to credentials without emitting cookies', async () => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.json()).data).toEqual({ requires2FA: false, accessToken: 'issued-access', refreshToken: 'issued-refresh' });
  });
  it('does not issue credentials when the original 2FA check fails', async () => {
    const res = await fetch(`${base}/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
  });
  it('does not expose trading mutations', async () => {
    expect((await fetch(`${base}/account`, { method: 'POST' })).status).toBe(404);
  });
});