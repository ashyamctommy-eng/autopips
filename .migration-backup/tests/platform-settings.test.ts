import './helpers/test-env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptCredential } from '@/lib/crypto/credential-cipher';
import { ApiError } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import {
  getSetting,
  listAdminSettings,
  resolvedAllowedCurrencies,
  saveAdminSetting,
} from '@/server/modules/settings/settings.service';
import { isDatabaseReachable } from './helpers/fixtures';

/**
 * PLATFORM SETTINGS — credential storage and override precedence.
 *
 * The admin console can now set the payment provider credentials at runtime.
 * Two properties matter more than the feature itself:
 *
 *   1. A CONSOLE VALUE MUST BE STORED ENCRYPTED. These rows are live provider
 *      credentials; a plaintext column would put them in every database dump.
 *   2. THE ENVIRONMENT VARIABLE REMAINS THE FALLBACK. Clearing a row must return
 *      the key to its deploy-time value — a settings bug must never be able to
 *      lock the operator out of the payment rail.
 *
 * SAFETY CONTRACT FOR THIS FILE (the suite shares one database):
 *   A platform-setting row is GLOBAL state, read by other specs in other
 *   workers. This file therefore writes ONLY `nowpayments.api_key` and
 *   `nowpayments.api_base` — read by the NOWPayments HTTP client, which no spec
 *   exercises (the provider round-trip cannot run offline). It deliberately does
 *   NOT touch `nowpayments.ipn_secret` (the IPN specs sign with it),
 *   `nowpayments.allowed_currencies` or `metaapi.token` (read by the payment and
 *   broker paths other specs drive). Every write is reverted in a `finally`, and
 *   `afterAll` restores whatever was there before the file ran.
 *
 * The validation block needs no database (it runs before any write); the rest is
 * DB-backed and skips itself when no Postgres is reachable, like the other
 * integration specs.
 */

const databaseReachable = await isDatabaseReachable();
if (!databaseReachable) {
  console.warn(
    `[platform-settings] DB-backed probes SKIPPED: no reachable SQL database (DATABASE_URL=${process.env.DATABASE_URL ?? 'unset'}).`,
  );
}
const describeDb = databaseReachable ? describe : describe.skip;

const ACTOR = { id: 'settings-test-actor', email: 'settings-suite@fixture.invalid' };

const TEST_API_KEY = 'test_secret_key_0123456789';
const TEST_API_BASE = 'https://api.nowpayments.io/v1';

/** Every key this file may write. See the safety contract above. */
const TEST_KEYS = ['nowpayments.api_key', 'nowpayments.api_base'] as const;

/** Rows that existed before the suite, restored afterwards. */
const priorRows = new Map<string, string | null>();

beforeAll(async () => {
  if (!databaseReachable) return;
  const existing = await prisma.platformSetting.findMany({ where: { key: { in: [...TEST_KEYS] } } });
  for (const key of TEST_KEYS) {
    const row = existing.find((r) => r.key === key);
    priorRows.set(key, row ? row.value : null);
  }
});

/** Put a key back exactly as this file found it (row restored, or removed). */
async function restoreKey(key: string): Promise<void> {
  const prior = priorRows.get(key);
  if (prior === undefined || prior === null) {
    await prisma.platformSetting.deleteMany({ where: { key } });
  } else {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value: prior },
      update: { value: prior },
    });
  }
}

afterAll(async () => {
  if (!databaseReachable) return;
  for (const key of TEST_KEYS) await restoreKey(key);
  await prisma.$disconnect().catch(() => undefined);
});

describe('validation runs before any write (no database required)', () => {
  it('refuses a secret that is too short', async () => {
    await expect(saveAdminSetting('nowpayments.api_key', 'short', ACTOR)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('refuses a secret containing whitespace', async () => {
    await expect(
      saveAdminSetting('nowpayments.api_key', 'has spaces in it 1234', ACTOR),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a relative or non-http API base', async () => {
    await expect(saveAdminSetting('nowpayments.api_base', 'not-a-url', ACTOR)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      saveAdminSetting('nowpayments.api_base', 'ftp://api.nowpayments.io/v1', ACTOR),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a currency list containing a non-ticker', async () => {
    await expect(
      saveAdminSetting('nowpayments.allowed_currencies', 'btc,<script>', ACTOR),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a key that is not an editable platform setting', async () => {
    await expect(saveAdminSetting('jwt_secret', 'whatever-long-enough', ACTOR)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('reports the environment value when nothing has been overridden', () => {
    // The fallback path needs no database: with nothing hydrated (or hydration
    // failing) the value must be the env var, never empty and never a guess.
    const fromEnv = (process.env.NOWPAYMENTS_API_KEY ?? '').trim();
    if (fromEnv) expect(getSetting('nowpayments.api_key')).toBe(fromEnv);

    const envCurrencies = (process.env.NOWPAYMENTS_ALLOWED_CURRENCIES ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (envCurrencies.length) expect(resolvedAllowedCurrencies()).toEqual(envCurrencies);
  });
});

describeDb('console overrides: encrypted at rest, and reversible', () => {
  it('stores a secret as an AES-256-GCM envelope and prefers it over the environment', async () => {
    try {
      await saveAdminSetting('nowpayments.api_key', TEST_API_KEY, ACTOR);

      const row = await prisma.platformSetting.findUnique({ where: { key: 'nowpayments.api_key' } });
      expect(row).not.toBeNull();
      expect(row!.isSecret).toBe(true);
      // The raw column must not contain the credential…
      expect(row!.value).not.toContain(TEST_API_KEY);
      // …and must be a versioned, decryptable envelope.
      expect(row!.value.startsWith('v1.')).toBe(true);
      expect(decryptCredential(row!.value)).toBe(TEST_API_KEY);
      expect(row!.updatedBy).toBe(ACTOR.email);

      // The override now wins over the environment for the payment client.
      expect(getSetting('nowpayments.api_key')).toBe(TEST_API_KEY);

      // …and the console sees it masked, with its source named.
      const view = (await listAdminSettings()).find((v) => v.key === 'nowpayments.api_key');
      expect(view!.source).toBe('console');
      expect(view!.display).toBeTruthy();
      expect(view!.display).not.toContain(TEST_API_KEY);
      expect(view!.display).toMatch(/\*{3}/);
    } finally {
      await saveAdminSetting('nowpayments.api_key', null, ACTOR);
    }
  });

  it('stores a non-secret value verbatim and normalises a URL', async () => {
    try {
      await saveAdminSetting('nowpayments.api_base', `${TEST_API_BASE}/`, ACTOR);

      const row = await prisma.platformSetting.findUnique({ where: { key: 'nowpayments.api_base' } });
      expect(row!.isSecret).toBe(false);
      // Non-secrets are readable by an operator, so they are stored as typed.
      expect(row!.value).toBe(TEST_API_BASE);
      expect(getSetting('nowpayments.api_base')).toBe(TEST_API_BASE);
    } finally {
      await saveAdminSetting('nowpayments.api_base', null, ACTOR);
    }
  });

  it('clearing a row returns the key to its environment value', async () => {
    await saveAdminSetting('nowpayments.api_key', TEST_API_KEY, ACTOR);
    expect(getSetting('nowpayments.api_key')).toBe(TEST_API_KEY);

    const result = await saveAdminSetting('nowpayments.api_key', null, ACTOR);
    expect(result.action).toBe('cleared');

    const row = await prisma.platformSetting.findUnique({ where: { key: 'nowpayments.api_key' } });
    expect(row).toBeNull();

    // Back to the deploy-time value, not empty.
    const fromEnv = (process.env.NOWPAYMENTS_API_KEY ?? '').trim();
    expect(getSetting('nowpayments.api_key')).toBe(fromEnv);

    if (fromEnv) {
      const view = (await listAdminSettings()).find((v) => v.key === 'nowpayments.api_key');
      expect(view!.source).toBe('environment');
    }
  });
});
