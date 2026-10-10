import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  hash: vi.fn(),
  verify: vi.fn(),
  policy: vi.fn(),
}));
vi.mock('../src/imported/lib/prisma', () => ({
  prisma: { $transaction: (fn: (tx: typeof mocks.tx) => Promise<void>) => fn(mocks.tx) },
}));
vi.mock('../src/imported/server/modules/auth/password.service', () => ({
  assertPasswordPolicy: mocks.policy,
  hashPassword: mocks.hash,
  verifyPassword: mocks.verify,
}));
import { bootstrapProductionAdmin } from '../src/bootstrap-admin';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('ADMIN_SETUP_EMAIL', 'admin@example.test');
  vi.stubEnv('ADMIN_SETUP_PASSWORD', 'Test-fixture-only-123!');
  mocks.tx.user.findUnique.mockResolvedValue(null);
  mocks.tx.user.create.mockResolvedValue({ id: 'test-admin' });
  mocks.hash.mockResolvedValue('test-hash');
  mocks.verify.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

it('creates an admin with a hash and an audit marker', async () => {
  await bootstrapProductionAdmin();
  expect(mocks.policy).toHaveBeenCalled();
  expect(mocks.tx.user.findUnique).toHaveBeenCalledWith({
    where: { email: 'admin@example.test' },
  });
  expect(mocks.tx.user.create).toHaveBeenCalledWith({
    data: {
      email: 'admin@example.test',
      role: 'SUPER_ADMIN',
      passwordHash: 'test-hash',
      fullName: 'Administrator',
      country: '',
    },
  });
  expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ action: 'PRODUCTION_ADMIN_PROVISIONED' }),
  });
});

it('uses ceo@baltimorecapital.pro when no admin email is configured', async () => {
  vi.stubEnv('ADMIN_SETUP_EMAIL', '');
  vi.stubEnv('ADMIN_EMAIL', '');

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.findUnique).toHaveBeenCalledWith({
    where: { email: 'ceo@baltimorecapital.pro' },
  });
  expect(mocks.tx.user.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      email: 'ceo@baltimorecapital.pro',
      role: 'SUPER_ADMIN',
      passwordHash: 'test-hash',
    }),
  });
});

it('supports deployment environment aliases and normalizes the configured email', async () => {
  vi.stubEnv('ADMIN_SETUP_EMAIL', '');
  vi.stubEnv('ADMIN_SETUP_PASSWORD', '');
  vi.stubEnv('ADMIN_EMAIL', ' CEO@BALTIMORECAPITAL.PRO ');
  vi.stubEnv('ADMIN_PASSWORD', 'Test-fixture-only-123!');

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.findUnique).toHaveBeenCalledWith({
    where: { email: 'ceo@baltimorecapital.pro' },
  });
  expect(mocks.tx.user.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      email: 'ceo@baltimorecapital.pro',
      role: 'SUPER_ADMIN',
      passwordHash: 'test-hash',
    }),
  });
});

it('updates an existing account role and replaces a non-matching password hash', async () => {
  mocks.tx.user.findUnique.mockResolvedValue({
    id: 'existing-admin',
    role: 'USER',
    passwordHash: 'old-hash',
  });
  mocks.verify.mockResolvedValue(false);

  await bootstrapProductionAdmin();

  expect(mocks.verify).toHaveBeenCalledWith('old-hash', 'Test-fixture-only-123!');
  expect(mocks.hash).toHaveBeenCalledWith('Test-fixture-only-123!');
  expect(mocks.tx.user.update).toHaveBeenCalledWith({
    where: { id: 'existing-admin' },
    data: { role: 'SUPER_ADMIN', passwordHash: 'test-hash' },
  });
  expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      userId: 'existing-admin',
      action: 'PRODUCTION_ADMIN_SYNCED',
    }),
  });
});

it('does not rewrite an already-synchronized super admin on every restart', async () => {
  mocks.tx.user.findUnique.mockResolvedValue({
    id: 'existing-admin',
    role: 'SUPER_ADMIN',
    passwordHash: 'current-hash',
  });
  mocks.verify.mockResolvedValue(true);

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.update).not.toHaveBeenCalled();
  expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  expect(mocks.hash).not.toHaveBeenCalled();
});

it('does not run in development', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  await bootstrapProductionAdmin();
  expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
});

it('fails clearly if no bootstrap password secret is configured', async () => {
  vi.stubEnv('ADMIN_SETUP_PASSWORD', '');
  vi.stubEnv('ADMIN_PASSWORD', '');
  await expect(bootstrapProductionAdmin()).rejects.toThrow(
    'Admin setup requires ADMIN_SETUP_PASSWORD or ADMIN_PASSWORD.',
  );
  expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
});

it('promotes an existing account even when its current password already matches', async () => {
  mocks.tx.user.findUnique.mockResolvedValue({
    id: 'existing-user',
    role: 'USER',
    passwordHash: 'current-hash',
  });
  mocks.verify.mockResolvedValue(true);

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.update).toHaveBeenCalledWith({
    where: { id: 'existing-user' },
    data: { role: 'SUPER_ADMIN' },
  });
  expect(mocks.hash).not.toHaveBeenCalled();
});

it('rejects an invalid configured password without writing an account', async () => {
  mocks.policy.mockImplementation(() => {
    throw new Error('Password policy');
  });
  await expect(bootstrapProductionAdmin()).rejects.toThrow('Password policy');
  expect(mocks.tx.user.create).not.toHaveBeenCalled();
  expect(mocks.tx.user.update).not.toHaveBeenCalled();
});

it('normalizes a configured email before lookup', async () => {
  vi.stubEnv('ADMIN_SETUP_EMAIL', ' CeO@Baltimorecapital.Pro ');

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.findUnique).toHaveBeenCalledWith({
    where: { email: 'ceo@baltimorecapital.pro' },
  });
});

it('does not create a duplicate when the configured email already exists', async () => {
  mocks.tx.user.findUnique.mockResolvedValue({
    id: 'existing-user',
    role: 'SUPER_ADMIN',
    passwordHash: 'current-hash',
  });
  mocks.verify.mockResolvedValue(true);

  await bootstrapProductionAdmin();

  expect(mocks.tx.user.create).not.toHaveBeenCalled();
});