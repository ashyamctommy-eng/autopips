import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_EXAMPLE,
  PLAN_FIELD_GUIDE,
  planInputSchema,
  planUpdateSchema,
} from '@/server/modules/admin/plan-validation';

/**
 * PLAN EXAMPLE — the format an operator copies from the console.
 *
 * An example is only worth showing if it is one the API would actually accept,
 * so it is asserted against the same schema the create route enforces. This also
 * catches the failure mode that matters most for a copy-paste template: a
 * misspelled field name, which zod would silently STRIP rather than reject,
 * leaving an operator with a plan missing a value they thought they had set.
 */
describe('the plan example is a real, valid plan', () => {
  it('passes the create contract the API enforces', () => {
    const parsed = planInputSchema.safeParse(PLAN_EXAMPLE);
    if (!parsed.success) {
      throw new Error(`PLAN_EXAMPLE is invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('uses only known fields — no key is silently stripped', () => {
    const parsed = planInputSchema.parse(PLAN_EXAMPLE);
    // Equal, key for key: a typo would be dropped here and the example would be
    // documenting a field the API does not have.
    expect(parsed).toEqual(PLAN_EXAMPLE);
  });

  it('satisfies the cross-field rules the console would reject it for', () => {
    expect(PLAN_EXAMPLE.maxInvestment).toBeGreaterThan(PLAN_EXAMPLE.minInvestment);
    expect(PLAN_EXAMPLE.targetReturnMax).toBeGreaterThanOrEqual(PLAN_EXAMPLE.targetReturnMin);
    expect(PLAN_EXAMPLE.maxDrawdown).toBeGreaterThan(0);
    expect(Number.isInteger(PLAN_EXAMPLE.durationDays)).toBe(true);
  });

  it('is a plausible plan rather than a stray default', () => {
    expect(PLAN_EXAMPLE.name.length).toBeGreaterThanOrEqual(3);
    expect(PLAN_EXAMPLE.description.length).toBeGreaterThanOrEqual(10);
    expect(PLAN_EXAMPLE.durationDays).toBeGreaterThanOrEqual(1);
    // A range, not a single figure: a plan that advertised one exact return
    // would be a guarantee, which this platform does not make.
    expect(PLAN_EXAMPLE.targetReturnMax).not.toBe(PLAN_EXAMPLE.targetReturnMin);
  });

  it('is accepted by the update schema too (PATCH semantics)', () => {
    expect(planUpdateSchema.safeParse(PLAN_EXAMPLE).success).toBe(true);
  });

  it('would be REJECTED if a bound were broken — the schema is really running', () => {
    expect(planInputSchema.safeParse({ ...PLAN_EXAMPLE, maxInvestment: 1 }).success).toBe(false);
    expect(planInputSchema.safeParse({ ...PLAN_EXAMPLE, maxDrawdown: 0 }).success).toBe(false);
    expect(planInputSchema.safeParse({ ...PLAN_EXAMPLE, riskLevel: 'EXTREME' }).success).toBe(false);
  });

  it('documents every field it sets, and no field it does not', () => {
    const guide = PLAN_FIELD_GUIDE.map((entry) => entry.field).sort();
    expect(guide).toEqual(Object.keys(PLAN_EXAMPLE).sort());
  });
});

/**
 * BOOT CONTRACT — the failure that took sign-in down in production.
 *
 * `serverEnv()` is what every server module trusts, and it is cached on first
 * use. When nothing validated it at boot, a variable added by a later change
 * (`DERIV_APP_ID`) went unnoticed until the first request that needed it — which
 * happened to be the login success path, so a correct password returned 500
 * while every other surface looked healthy. The web process now validates in
 * `src/instrumentation.ts` before it serves traffic; this pins the underlying
 * behaviour that makes that necessary.
 */
describe('the environment contract', () => {
  it('throws, naming the variable, when a required one is missing', async () => {
    const saved = process.env.DERIV_APP_ID;
    try {
      delete process.env.DERIV_APP_ID;
      vi.resetModules();
      const { serverEnv } = await import('@/lib/env');
      expect(() => serverEnv()).toThrow(/DERIV_APP_ID/);
    } finally {
      if (saved === undefined) delete process.env.DERIV_APP_ID;
      else process.env.DERIV_APP_ID = saved;
      vi.resetModules();
    }
  });

  it('parses and caches the environment when it is complete', async () => {
    /**
     * The full required set, spelled out. A test process has no `.env` (vitest
     * does not load one), so "complete" has to be stated rather than inherited —
     * and that statement is itself useful: it is the exact list a deployment
     * must provide. Anything else in the schema has a default.
     */
    const complete: Record<string, string> = {
      WS_INTERNAL_TOKEN: 'test-internal-token-0123456789',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_SECRET: 'test-jwt-secret-that-is-long-enough-to-pass',
      CREDENTIAL_ENCRYPTION_KEY: 'test-credential-encryption-key-32ch+',
      AWS_REGION: 'eu-west-1',
      AWS_KYC_BUCKET: 'test-kyc-bucket',
      NOWPAYMENTS_API_KEY: 'test-nowpayments-key',
      NOWPAYMENTS_IPN_SECRET: 'test-nowpayments-ipn-secret',
      DERIV_APP_ID: '1089',
    };

    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(complete)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      vi.resetModules();
      const { serverEnv } = await import('@/lib/env');
      const first = serverEnv();
      expect(first.DERIV_APP_ID).toBe('1089');
      // Cached: the same object comes back, so the schema is not re-parsed per call.
      expect(serverEnv()).toBe(first);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });
});
