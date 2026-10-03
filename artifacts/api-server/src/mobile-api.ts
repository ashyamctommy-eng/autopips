import { Router, type Response } from 'express';
import { z } from 'zod';
import { requestContext } from './imported/lib/request-context';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './imported/server/modules/auth/token.service';
import { requireSessionUser } from './imported/server/modules/auth/session';
import { getAccountSnapshot } from './imported/server/accounting/ledger';
import { listActivity, listPositions as brokerPositions } from './imported/server/modules/account/account.service';
import { listPositions } from './imported/server/modules/positions/position.service';
import { serverEnv } from './imported/lib/env';
import { POST as login } from './imported/app/api/v1/auth/login/route';
import { POST as challenge } from './imported/app/api/v1/auth/2fa/challenge/route';
import { POST as refresh } from './imported/app/api/v1/auth/refresh/route';
import { POST as logout } from './imported/app/api/v1/auth/logout/route';

const router = Router();
// Bearer transport is deliberately restricted to this read-only companion API.
// Browser cookies, user IDs, roles and arbitrary service names are not accepted.
router.use('/api/mobile', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  req.cookies = {};
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
  if (match) req.cookies[ACCESS_COOKIE] = match[1];
  next();
});

const authHandlers = { login, challenge, refresh, logout } as const;
for (const [name, handler] of Object.entries(authHandlers)) {
  router.post(`/api/mobile/auth/${name}`, async (req, res) => {
    // Use the original password/2FA/rate-limit/rotation/revocation implementations.
    // Cookie writes are captured request-locally, never sent to the browser.
    const issued: Record<string, string> = {};
    const cookieSink = { cookie(key: string, value: string) { issued[key] = value; } } as unknown as Response;
    if (name === 'refresh' || name === 'logout') {
      const parsed = z.object({ refreshToken: z.string().max(1024).optional() }).safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid session request.' } }); return; }
      if (parsed.data.refreshToken) req.cookies[REFRESH_COOKIE] = parsed.data.refreshToken;
    }
    await requestContext.run({ req, res: cookieSink }, async () => {
      try {
        const headers = new Headers({ 'content-type': 'application/json' });
        // Preserve the original trusted IP/rate-limiting semantics.
        for (const key of ['x-forwarded-for', 'x-real-ip']) {
          const value = req.headers[key];
          if (typeof value === 'string') headers.set(key, value);
        }
        const result = await handler(new Request(`https://mobile.invalid/api/mobile/auth/${name}`, {
          method: 'POST', headers, body: JSON.stringify(req.body ?? {}),
        }));
        const payload = await result.json() as { ok?: boolean; data: Record<string, unknown> };
        if (result.ok && payload.ok && issued[ACCESS_COOKIE] && issued[REFRESH_COOKIE]) {
          payload.data.accessToken = issued[ACCESS_COOKIE];
          payload.data.refreshToken = issued[REFRESH_COOKIE];
        }
        res.status(result.status).json(payload);
      } catch {
        res.status(503).json({ error: { message: 'Sign-in service unavailable. Please try again.' } });
      }
    });
  });
}

router.get('/api/mobile/account', async (req, res) => {
  await requestContext.run({ req, res }, async () => {
    try {
      const user = await requireSessionUser();
      const { cursor } = z.object({ cursor: z.string().max(150).optional() }).parse(req.query);
      const mode = serverEnv().EXECUTION_MODE;
      const [snapshot, activity, positions] = await Promise.all([
        getAccountSnapshot(user.id),
        listActivity(user.id, 50),
        mode === 'internal' ? listPositions(user.id, { take: 25, cursor }) : brokerPositions(user.id),
      ]);
      const internal = !Array.isArray(positions);
      const rows = internal ? positions.items.map(p => ({
        id: p.id, symbol: p.symbol, side: p.side, status: p.status,
        stake: String(p.stake), entryPrice: String(p.entryPrice),
        currentPrice: String(p.currentPrice), pnl: String(p.pnl), openedAt: p.openedAt,
      })) : positions.map(p => ({
        id: p.id, symbol: p.instrument, side: p.direction, status: p.status,
        stake: null, entryPrice: String(p.entryPrice),
        currentPrice: p.currentPrice === null ? null : String(p.currentPrice),
        // An OPEN broker row's default zero is not a verified live P/L.
        pnl: p.status === 'OPEN' ? null : String(p.netPnL), openedAt: p.openedAt,
      }));
      res.json({
        user: { fullName: user.fullName, email: user.email, kycStatus: user.kycStatus },
        wallet: {
          availableUsd: snapshot.withdrawableBalance.toFixed(2),
          deployedUsd: snapshot.activeCapital.toFixed(2),
          equityUsd: snapshot.breakdown.equity.toFixed(2),
          pendingWithdrawalsUsd: snapshot.pendingWithdrawals.toFixed(2),
        },
        positions: rows, nextCursor: internal ? positions.nextCursor : null,
        activity: activity.map(({ id, message, severity, createdAt }) => ({ id, message, severity, createdAt })),
        executionMode: mode,
        payments: mode === 'internal' ? 'External payments disabled in internal execution mode.'
          : 'Payments are not available in this read-only companion. Check provider availability on the website.',
        market: 'Live quotes are unavailable in this companion. Prices and P/L below are stored records, not a live market feed.',
        updatedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const failure = error as { status?: number; message?: string };
      res.status(error instanceof z.ZodError ? 400 : failure.status ?? 503).json({
        error: { message: failure.status ? failure.message : 'Account information is unavailable. Please try again.' },
      });
    }
  });
});
export default router;