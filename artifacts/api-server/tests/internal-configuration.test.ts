import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Synthetic test fixtures only; never used by any running application.
vi.mock('@/server/modules/settings/settings.service', () => ({ getSetting: () => '' }));

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
    REDIS_URL: 'redis://127.0.0.1:6379', JWT_SECRET: 'test-only-not-a-real-secret-'.repeat(3),
    CREDENTIAL_ENCRYPTION_KEY: 'test-only-encryption-key-not-for-runtime',
    WS_INTERNAL_TOKEN: 'test-only-worker-token-not-for-runtime',
    EXECUTION_MODE: 'internal', NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: '',
    DERIV_APP_ID: '',
  })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe('internal-mode configuration', () => {
  it('boots without external payment or broker credentials', async () => {
    const { serverEnv } = await import('@/lib/env');
    expect(serverEnv().EXECUTION_MODE).toBe('internal');
    const { missingConfiguration } = await import('../src/migration-api');
    expect(missingConfiguration()).toEqual([]);
  });
  it('still requires provider configuration in broker mode', async () => {
    vi.stubEnv('EXECUTION_MODE', 'broker');
    const { serverEnv } = await import('@/lib/env');
    expect(() => serverEnv()).toThrow('Required in broker mode');
  });
  it('never makes security keys optional', async () => {
    vi.stubEnv('JWT_SECRET', '');
    const { serverEnv } = await import('@/lib/env');
    expect(() => serverEnv()).toThrow('JWT_SECRET');
  });
  it('rejects a forged webhook signed with an empty provider secret', async () => {
    const { verifyIpnSignature } = await import('@/server/modules/payments/ipn.service');
    const rawBody = '{"payment_id":123}';
    const signatureHeader = createHmac('sha512', '').update(rawBody).digest('hex');
    expect(verifyIpnSignature({ rawBody, signatureHeader })).toEqual({
      valid: false, reason: 'PROVIDER_NOT_CONFIGURED',
    });
  });
  it('rejects even a correctly signed external payment in internal mode', async () => {
    const secret = 'test-only-provider-secret';
    vi.stubEnv('NOWPAYMENTS_IPN_SECRET', secret);
    const { verifyIpnSignature } = await import('@/server/modules/payments/ipn.service');
    const rawBody = '{"payment_id":123}';
    const signatureHeader = createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(verifyIpnSignature({ rawBody, signatureHeader })).toEqual({
      valid: false, reason: 'EXTERNAL_PAYMENTS_DISABLED',
    });
  });
});