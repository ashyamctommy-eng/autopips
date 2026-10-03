import { Router } from 'express';
import { requestContext } from './imported/lib/request-context';
import { importedRoutes } from './imported-routes';
import { z } from 'zod';

const router = Router();

const services = {
  'server/modules/auth/session': () => import('./imported/server/modules/auth/session'),
  'server/modules/account/account.service': () => import('./imported/server/modules/account/account.service'),
  'server/modules/admin/admin.service': () => import('./imported/server/modules/admin/admin.service'),
  'server/modules/audit/audit.service': () => import('./imported/server/modules/audit/audit.service'),
  'server/modules/positions/position.service': () => import('./imported/server/modules/positions/position.service'),
  'server/modules/payments/payments.service': () => import('./imported/server/modules/payments/payments.service'),
  'server/modules/kyc/kyc.service': () => import('./imported/server/modules/kyc/kyc.service'),
  'server/modules/market/public-market.service': () => import('./imported/server/modules/market/public-market.service'),
  'server/modules/settings/settings.service': () => import('./imported/server/modules/settings/settings.service'),
  'server/modules/legal/disclosure': () => import('./imported/server/modules/legal/disclosure'),
} as const;

// A closed list, not an arbitrary remote service invocation.
const readMethods: Record<string, readonly string[]> = {
  'server/modules/auth/session': ['getSessionUser', 'requireSessionUser'],
  'server/modules/account/account.service': ['getOverview', 'listInvestments', 'listPositions', 'listTrades', 'listActivity', 'listActivePlans'],
  'server/modules/admin/admin.service': ['getAumSummary', 'listUsers', 'listPlans', 'listBrokers', 'getBotControlView', 'getAdminActivity', 'getAdminOverview'],
  'server/modules/audit/audit.service': ['listAudit'],
  'server/modules/positions/position.service': ['listPositions', 'getWallet'],
  'server/modules/payments/payments.service': ['listDeposits', 'listWithdrawals', 'listSupportedCurrencies', 'adminListDeposits', 'adminListWithdrawals'],
  'server/modules/kyc/kyc.service': ['getMyKyc', 'listKycQueue'],
  'server/modules/market/public-market.service': ['listPublicSymbols'],
  'server/modules/settings/settings.service': ['listAdminSettings'],
  'app/admin/_lib/admin-data': ['countPendingWithdrawals', 'attachWithdrawalEmails'],
  'server/modules/legal/disclosure': ['isInternalExecutionMode', 'internalExecutionNotice'],
};

const querySchema = z.object({
  module: z.string().max(160),
  method: z.string().max(80),
  args: z.array(z.unknown()).max(8).default([]),
}).strict();

export function missingConfiguration() {
  return ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'CREDENTIAL_ENCRYPTION_KEY',
    'WS_INTERNAL_TOKEN', 'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'DERIV_APP_ID']
    .filter(key => !process.env[key]);
}

function setupResponse(res: import('express').Response) {
  res.status(503).json({
    ok: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'The imported backend needs its service configuration before it can handle accounts or trading.', details: { missing: missingConfiguration() } },
  });
}

router.get('/api/migration/status', (_req, res) => {
  const missing = missingConfiguration();
  res.status(missing.length ? 503 : 200).json({ ok: !missing.length, missing });
});

router.post('/api/migration/query', async (req, res) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid read request.' } });
    return;
  }
  const { module, method, args } = parsed.data;
  if (!readMethods[module]?.includes(method)) {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown read operation.' } });
    return;
  }
  await requestContext.run({ req, res }, async () => {
    try {
      const session = await import('./imported/server/modules/auth/session');
      // Anonymous checks need no database when no session cookie is present.
      if (module === 'server/modules/auth/session' && method === 'getSessionUser') {
        const data = await session.getSessionUser();
        res.json({ ok: true, data });
        return;
      }
      const publicRead = (module === 'server/modules/account/account.service' && method === 'listActivePlans') ||
        module === 'server/modules/legal/disclosure';
      if (!publicRead) {
        const user = await session.requireSessionUser();
        const staffRead = module.includes('/admin/') || module.includes('/audit/') ||
          module.includes('/settings/') || method.startsWith('adminList') || method === 'listKycQueue' ||
          module === 'app/admin/_lib/admin-data';
        if (staffRead) await session.requireAdminOrManager();
        else if (module.includes('/account/') || module.includes('/positions/') ||
          (module.includes('/payments/') && method !== 'listSupportedCurrencies') ||
          method === 'getMyKyc') {
          // Never trust the client to pick whose account to read.
          args[0] = user.id;
        }
      }
      // Public plan catalog reads only the database; provider and session
      // credentials must not stop visitors viewing an honest empty catalog.
      const planCatalogRead = module === 'server/modules/account/account.service' && method === 'listActivePlans';
      if (!planCatalogRead && missingConfiguration().length) {
        setupResponse(res);
        return;
      }
      if (module === 'app/admin/_lib/admin-data') {
        const { prisma } = await import('./imported/lib/prisma');
        if (method === 'countPendingWithdrawals') {
          res.json({ ok: true, data: await prisma.withdrawal.count({ where: { status: 'PENDING' } }) });
        } else {
          const rows = z.array(z.object({ id: z.string() }).passthrough()).max(500).parse(args[0]);
          const owners = await prisma.withdrawal.findMany({
            where: { id: { in: rows.map(row => row.id) } },
            select: { id: true, user: { select: { email: true } } },
          });
          const emails = new Map(owners.map(row => [row.id, row.user.email]));
          res.json({ ok: true, data: rows.map(row => ({ ...row, userEmail: emails.get(row.id) ?? null })) });
        }
        return;
      }
      const service = await services[module as keyof typeof services]();
      const data = await (service as any)[method](...args);
      res.json({ ok: true, data });
    } catch (error: any) {
      req.log.error({ err: error }, 'Imported read operation failed');
      res.status(error.status ?? 500).json({ ok: false, error: { code: error.code ?? 'INTERNAL', message: error.status ? error.message : 'Unable to load this information.' } });
    }
  });
});

for (const route of importedRoutes) {
  router.all(route.path, async (req, res) => {
    const catalogRequest = route.path === '/api/v1/plans' && (req.method === 'GET' || req.method === 'HEAD');
    if (!catalogRequest && missingConfiguration().length) {
      setupResponse(res);
      return;
    }
    await requestContext.run({ req, res }, async () => {
      try {
        const handlers = await route.load();
        const handler = (handlers as any)[req.method];
        if (!handler) {
          res.setHeader('Allow', Object.keys(handlers).filter(key => /^[A-Z]+$/.test(key)).join(', '));
          res.status(405).end();
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        // Raw bytes are essential for payment webhook signatures and multipart uploads.
        const rawBody = (req as any).rawBody as Buffer | undefined;
        const request = new Request(new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`), {
          method: req.method,
          headers,
          ...(req.method !== 'GET' && req.method !== 'HEAD' && rawBody?.length ? { body: rawBody } : {}),
        });
        const response: Response = await handler(request, { params: req.params });
        response.headers.forEach((value, name) => {
          if (name !== 'set-cookie') res.setHeader(name, value);
        });
        const responseCookies = response.headers.getSetCookie();
        if (responseCookies.length) {
          const prior = res.getHeader('set-cookie');
          res.setHeader('set-cookie', [...(Array.isArray(prior) ? prior : prior ? [String(prior)] : []), ...responseCookies]);
        }
        res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        req.log.error({ err: error }, 'Imported HTTP handler failed');
        if (!res.headersSent) res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Internal server error.' } });
      }
    });
  });
}

export default router;