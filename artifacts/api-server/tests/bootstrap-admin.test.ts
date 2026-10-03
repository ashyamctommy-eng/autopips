import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  },
  hash: vi.fn(),
  policy: vi.fn(),
}));
vi.mock('../src/imported/lib/prisma', () => ({
  prisma: { $transaction: (fn: (tx: typeof mocks.tx) => Promise<void>) => fn(mocks.tx) },
}));
vi.mock('../src/imported/server/modules/auth/password.service', () => ({
  assertPasswordPolicy: mocks.policy, hashPassword: mocks.hash,
}));
import { bootstrapProductionAdmin } from '../src/bootstrap-admin';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('ADMIN_SETUP_EMAIL', 'admin@example.test');
  vi.stubEnv('ADMIN_SETUP_PASSWORD', 'Test-fixture-only-123!');
  mocks.tx.user.count.mockResolvedValue(0);
  mocks.tx.user.create.mockResolvedValue({ id: 'test-admin' });
  mocks.hash.mockResolvedValue('test-hash');
});
afterEach(() => vi.unstubAllEnvs());

it('creates an admin with a hash and an audit marker', async () => {
  await bootstrapProductionAdmin();
  expect(mocks.policy).toHaveBeenCalled();
  expect(mocks.tx.user.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ role: 'SUPER_ADMIN', passwordHash: 'test-hash' }),
  });
  expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ action: 'PRODUCTION_ADMIN_PROVISIONED' }),
  });
});
it('does not run in development', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  await bootstrapProductionAdmin();
  expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
});
it('requires explicit opt-in', async () => {
  vi.stubEnv('ADMIN_SETUP_EMAIL', '');
  await bootstrapProductionAdmin();
  expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
});
it('does not recreate an account after the marker exists', async () => {
  mocks.tx.auditLog.findFirst.mockResolvedValue({ id: 'marker' });
  await bootstrapProductionAdmin();
  expect(mocks.tx.user.create).not.toHaveBeenCalled();
});
it('does not change an existing administrator', async () => {
  mocks.tx.user.count.mockResolvedValue(1);
  await bootstrapProductionAdmin();
  expect(mocks.tx.user.create).not.toHaveBeenCalled();
});
it('does not promote a colliding account', async () => {
  mocks.tx.user.findUnique.mockResolvedValue({ id: 'client' });
  await expect(bootstrapProductionAdmin()).rejects.toThrow('already exists');
  expect(mocks.tx.user.create).not.toHaveBeenCalled();
});
it('rejects an invalid password without creating an account', async () => {
  mocks.policy.mockImplementation(() => { throw new Error('Password policy'); });
  await expect(bootstrapProductionAdmin()).rejects.toThrow('Password policy');
  expect(mocks.tx.user.create).not.toHaveBeenCalled();
});