import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  rateLimit: vi.fn(),
  recordAudit: vi.fn(),
  recordAuditSafe: vi.fn(),
  issueSession: vi.fn(),
  setAuthCookies: vi.fn(),
  toSessionUser: vi.fn(),
  issue2faChallenge: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: mocks.rateLimit,
}));
vi.mock('@/server/modules/audit/audit.service', () => ({
  AUDIT: {
    AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
    AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  },
  recordAudit: mocks.recordAudit,
  recordAuditSafe: mocks.recordAuditSafe,
}));
vi.mock('@/server/modules/auth/session-issue', () => ({
  issueSession: mocks.issueSession,
  setAuthCookies: mocks.setAuthCookies,
  toSessionUser: mocks.toSessionUser,
}));
vi.mock('@/server/modules/auth/twofactor.service', () => ({
  issue2faChallenge: mocks.issue2faChallenge,
}));
vi.mock('@/lib/ops-alert', () => ({
  alertOps: vi.fn(),
}));

import { POST } from '../src/imported/app/api/v1/auth/login/route';
import { hashPassword } from '../src/imported/server/modules/auth/password.service';

const FIXTURE_PASSWORD = 'Unit-fixture-Admin-123!';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetSeconds: 900,
    limit: 10,
  });
  mocks.issueSession.mockResolvedValue({ sessionId: 'session-fixture' });
  mocks.toSessionUser.mockImplementation((user) => ({
    id: user.id,
    email: user.email,
    role: user.role,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('normalizes the email and verifies the Argon2 hash stored in the database', async () => {
  const passwordHash = await hashPassword(FIXTURE_PASSWORD);
  mocks.findUnique.mockResolvedValue({
    id: 'admin-fixture',
    email: 'ceo@baltimorecapital.pro',
    passwordHash,
    role: 'SUPER_ADMIN',
    is2FAEnabled: false,
  });

  const response = await POST(
    new Request('https://api.example.test/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: ' CEO@Baltimorecapital.Pro ',
        password: FIXTURE_PASSWORD,
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(mocks.findUnique).toHaveBeenCalledWith({
    where: { email: 'ceo@baltimorecapital.pro' },
  });
  expect(mocks.issueSession).toHaveBeenCalled();
  expect(mocks.setAuthCookies).toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: {
      user: { id: 'admin-fixture', email: 'ceo@baltimorecapital.pro', role: 'SUPER_ADMIN' },
      requires2FA: false,
    },
  });
});

it('does not accept an environment password when the stored database hash does not match', async () => {
  vi.stubEnv('ADMIN_PASSWORD', 'Environment-fixture-456!');
  mocks.findUnique.mockResolvedValue({
    id: 'admin-fixture',
    email: 'ceo@baltimorecapital.pro',
    passwordHash: await hashPassword(FIXTURE_PASSWORD),
    role: 'SUPER_ADMIN',
    is2FAEnabled: false,
  });

  const response = await POST(
    new Request('https://api.example.test/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ceo@baltimorecapital.pro',
        password: 'Wrong-fixture-789!',
      }),
    }),
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { message: 'Invalid email or password.' },
  });
  expect(mocks.issueSession).not.toHaveBeenCalled();
});
