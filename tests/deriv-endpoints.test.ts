import { describe, expect, it, vi } from 'vitest';

import {
  DERIV_PUBLIC_WS_URL,
  DERIV_REST_BASE_URL,
  DERIV_RETIRED_HOSTS,
  isDemoAccountSocketUrl,
  isRetiredDerivHost,
} from '@/server/modules/broker/deriv.endpoints';
import { buildSocketUrl } from '@/server/modules/broker/deriv.client';
import { mapDerivCandles } from '@/server/modules/broker/deriv.adapter';

/**
 * DERIV ENDPOINT MIGRATION
 *
 * Deriv moved its API and retired the old WebSocket host, which now answers
 * Cloudflare 520 to every request — every path, every app_id, from a cloud
 * sandbox, a Railway container and a real browser engine alike. Production
 * recorded it as "Could not reach Deriv: Unexpected server response: 520", and
 * it cost far too long to read because a 520 looks like a transient network
 * fault rather than a decommissioned endpoint.
 *
 * These tests pin the two things that keep that from happening again: the
 * retired host is refused where it is configured, and the bar mapper keeps
 * refusing to invent data on the way in.
 */
describe('the retired Deriv endpoint is refused, not retried', () => {
  it('recognises every retired host', () => {
    for (const host of DERIV_RETIRED_HOSTS) {
      expect(isRetiredDerivHost(`wss://${host}/websockets/v3`)).toBe(true);
      expect(isRetiredDerivHost(`https://${host}`)).toBe(true);
    }
  });

  it('accepts the current endpoint', () => {
    expect(isRetiredDerivHost(DERIV_PUBLIC_WS_URL)).toBe(false);
    expect(isRetiredDerivHost(DERIV_REST_BASE_URL)).toBe(false);
  });

  it('does not treat an unparseable value as retired (the schema rejects it separately)', () => {
    expect(isRetiredDerivHost('not a url')).toBe(false);
  });

  it('fails the environment contract with an actionable message', async () => {
    // The full required set, spelled out — a test process has no `.env`.
    const complete: Record<string, string> = {
      WS_INTERNAL_TOKEN: 'test-internal-token-0123456789',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_SECRET: 'test-jwt-secret-that-is-long-enough-to-pass',
      CREDENTIAL_ENCRYPTION_KEY: 'test-credential-encryption-key-32ch+',
      NOWPAYMENTS_API_KEY: 'test-nowpayments-key',
      NOWPAYMENTS_IPN_SECRET: 'test-nowpayments-ipn-secret',
      DERIV_APP_ID: '1089',
      DERIV_API_URL: 'wss://ws.derivws.com/websockets/v3',
    };

    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(complete)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      vi.resetModules();
      const { serverEnv } = await import('@/lib/env');
      expect(() => serverEnv()).toThrow(/retired/i);
      // The message must name the replacement, or it costs another outage to
      // work out what to set instead.
      expect(() => serverEnv()).toThrow(new RegExp(DERIV_PUBLIC_WS_URL.replace(/[/.]/g, '\\$&')));
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });
});

describe('the public feed is the default', () => {
  it('defaults DERIV_API_URL to the current public socket', () => {
    expect(DERIV_PUBLIC_WS_URL).toBe('wss://api.derivws.com/trading/v1/options/ws/public');
    expect(DERIV_REST_BASE_URL).toBe('https://api.derivws.com');
  });
});

/**
 * `mapDerivCandles` is the single gate every bar passes through, public feed and
 * authorised socket alike (see [[autopips-market-data-architecture]]).
 */
describe('candle mapping refuses to invent data', () => {
  const good = { epoch: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5 };

  it('keeps a complete bar', () => {
    const { candles, skipped } = mapDerivCandles([good]);
    expect(skipped).toBe(0);
    expect(candles).toEqual([{ time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5 }]);
  });

  it('drops a bar with a missing or non-numeric field instead of repairing it', () => {
    const { candles, skipped } = mapDerivCandles([
      good,
      { ...good, close: null },
      { ...good, epoch: 'yesterday' },
      { open: 1, high: 2, low: 0.5, close: 1.5 },
      'not an object',
    ]);
    expect(skipped).toBe(4);
    expect(candles).toHaveLength(1);
  });

  it('never produces a volume — Deriv sends none, and a guess would be a made-up number', () => {
    const { candles } = mapDerivCandles([{ ...good, volume: 42 }]);
    expect(candles[0]).not.toHaveProperty('volume');
  });

  it('sorts by time, so a chart cannot draw a series backwards', () => {
    const { candles } = mapDerivCandles([
      { ...good, epoch: 3 },
      { ...good, epoch: 1 },
      { ...good, epoch: 2 },
    ]);
    expect(candles.map((candle) => candle.time)).toEqual([1, 2, 3]);
  });
});

/**
 * AUTHENTICATED SOCKET URLS
 *
 * The account half of Deriv's API is an OTP exchange over REST: the response
 * carries a ready-to-use socket URL, `wss://api.derivws.com/trading/v1/options/ws/demo?otp=…`.
 * Two things about it are easy to get wrong, and both were.
 */
describe('OTP socket URLs', () => {
  it('keeps an existing query string when adding app_id', () => {
    const built = buildSocketUrl(
      'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc123',
      '1089',
    );
    // The old string concatenation produced `…?otp=abc123?app_id=1089`, where the
    // otp parameter swallowed the app id and the socket was rejected.
    expect(built).toContain('otp=abc123');
    expect(built).toContain('app_id=1089');
    expect(built).not.toContain('?app_id');
    expect(new URL(built).searchParams.get('otp')).toBe('abc123');
  });

  it('adds app_id to a plain URL', () => {
    expect(buildSocketUrl('wss://example.test/ws', '42')).toBe('wss://example.test/ws?app_id=42');
  });

  it('does not duplicate an app_id the URL already carries', () => {
    const built = buildSocketUrl('wss://example.test/ws?app_id=7', '42');
    expect(new URL(built).searchParams.getAll('app_id')).toEqual(['7']);
  });

  it('reads the demo/real signal from the URL Deriv issued, and never guesses', () => {
    expect(isDemoAccountSocketUrl('wss://api.derivws.com/trading/v1/options/ws/demo?otp=x')).toBe(
      true,
    );
    expect(isDemoAccountSocketUrl('wss://api.derivws.com/trading/v1/options/ws/real?otp=x')).toBe(
      false,
    );
    expect(isDemoAccountSocketUrl('wss://api.derivws.com/trading/v1/options/ws/public')).toBe(false);
    expect(isDemoAccountSocketUrl('nonsense')).toBe(false);
  });
});
