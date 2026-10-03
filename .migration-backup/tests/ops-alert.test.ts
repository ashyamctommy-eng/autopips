import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALERT_DEDUPE_WINDOW_SECONDS,
  ALERT_POST_TIMEOUT_MS,
  alertOps,
  buildAlertPayload,
  createInMemoryAlertDedupeStore,
  OPS_ALERT_WEBHOOK_ENV,
  redactDetail,
  type AlertDedupeStore,
} from '@/lib/ops-alert';

/**
 * OPS ALERTING — the contract that makes this safe to ship disabled.
 *
 * These tests pin four promises, in the order they matter:
 *   1. no `OPS_ALERT_WEBHOOK_URL` -> no network, no throw (safe to merge);
 *   2. the payload shape is a stable, Slack-compatible JSON body;
 *   3. obvious secrets and PII never reach that body;
 *   4. an identical title is delivered at most once per window, and a broken
 *      webhook/dedupe store can never make `alertOps` throw.
 *
 * The dedupe store and the fetch implementation are injected, so the rule is
 * deterministic with OR without the live Redis that the integration CI job runs.
 */

const realFetch = globalThis.fetch;
const originalWebhookUrl = process.env[OPS_ALERT_WEBHOOK_ENV];

let titleSequence = 0;
/** Unique per call so a stale Redis key from a previous run cannot interfere. */
function uniqueTitle(): string {
  titleSequence += 1;
  return `unit-test-alert-${Date.now()}-${titleSequence}`;
}

function jsonResponse(status = 200): Response {
  return new Response('ok', { status, headers: { 'content-type': 'text/plain' } });
}

beforeEach(() => {
  delete process.env[OPS_ALERT_WEBHOOK_ENV];
});

afterEach(() => {
  if (originalWebhookUrl === undefined) delete process.env[OPS_ALERT_WEBHOOK_ENV];
  else process.env[OPS_ALERT_WEBHOOK_ENV] = originalWebhookUrl;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('alertOps without a configured webhook', () => {
  it('is a silent no-op: no fetch, no throw', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse());
    const store = createInMemoryAlertDedupeStore();

    await expect(
      alertOps({ title: uniqueTitle(), severity: 'critical' }, { fetchImpl, store }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats an empty or whitespace URL as unset', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse());

    process.env[OPS_ALERT_WEBHOOK_ENV] = '   ';
    await alertOps({ title: uniqueTitle(), severity: 'error' }, { fetchImpl });
    process.env[OPS_ALERT_WEBHOOK_ENV] = '';
    await alertOps({ title: uniqueTitle(), severity: 'error' }, { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('buildAlertPayload (pure)', () => {
  it('builds a Slack-compatible body with the severity, title, detail and timestamp', () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    const payload = buildAlertPayload(
      {
        title: 'bot runtime stopped after a successful start',
        severity: 'critical',
        detail: { reason: 'lock-lost', cycleCount: 12 },
      },
      now,
    );

    expect(payload.text).toBeTypeOf('string');
    expect(payload.text).toContain('[CRITICAL]');
    expect(payload.text).toContain('bot runtime stopped after a successful start');
    expect(payload.text).toContain('"lock-lost"');
    expect(payload.severity).toBe('critical');
    expect(payload.title).toBe('bot runtime stopped after a successful start');
    expect(payload.detail).toEqual({ reason: 'lock-lost', cycleCount: 12 });
    expect(payload.timestamp).toBe('2026-09-26T12:00:00.000Z');

    // Round-trips as JSON, which is what actually goes on the wire.
    const wire = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(wire).toEqual(payload);
    expect(Object.keys(wire)).toContain('text');
  });

  it('omits the detail suffix when there is nothing to report', () => {
    const payload = buildAlertPayload({ title: 'no detail', severity: 'info' });
    expect(payload.text).toBe('[INFO] no detail');
    expect(payload.detail).toEqual({});
  });

  it('caps oversized detail instead of sending an unreadable message', () => {
    const payload = buildAlertPayload({
      title: 'huge detail',
      severity: 'warning',
      detail: { blob: Array.from({ length: 800 }, (_, i) => `field-${i}`).join(' ') },
    });
    const serialized = JSON.stringify(payload.detail);
    expect(serialized).toContain('_truncated');
    expect(serialized.length).toBeLessThan(10_000);
  });
});

describe('redaction (no secrets, no PII)', () => {
  it('drops secret-ish keys and scrubs secret/PII shapes out of values', () => {
    const redacted = redactDetail({
      apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789',
      password: 'hunter2',
      accountNumber: '12345678901234',
      email: 'client@example.com',
      databaseUrl: 'postgresql://autopips:sup3rsecret@db.internal:5432/autopips',
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      nested: { wsInternalToken: 'abcdefghijklmnopqrstuvwxyz012345' },
      safe: 'route-level context',
      count: 3,
    });

    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.password).toBe('[redacted]');
    expect(redacted.accountNumber).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).wsInternalToken).toBe('[redacted]');
    expect(redacted.safe).toBe('route-level context');
    expect(redacted.count).toBe(3);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-');
    expect(serialized).not.toContain('sup3rsecret');
    expect(serialized).not.toContain('client@example.com');
    expect(serialized).not.toContain('12345678901234');
  });

  it('keeps an Error message but still scrubs its secrets', () => {
    const redacted = redactDetail({ error: new Error('connect failed to postgresql://user:secret@db:5432/x') });
    expect(redacted.error).toEqual({ name: 'Error', message: 'connect failed to postgresql://user:[redacted]@db:5432/x' });
  });
});

describe('deduplication', () => {
  it('delivers the first identical title and suppresses repeats inside the window', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    const store = createInMemoryAlertDedupeStore();
    const fetchImpl = vi.fn(async () => jsonResponse());
    const title = uniqueTitle();

    await alertOps({ title, severity: 'error' }, { store, fetchImpl });
    await alertOps({ title, severity: 'error' }, { store, fetchImpl });
    await alertOps({ title, severity: 'error' }, { store, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('delivers again once the window has elapsed', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    let clock = 1_000;
    const store = createInMemoryAlertDedupeStore(() => clock);
    const fetchImpl = vi.fn(async () => jsonResponse());
    const title = uniqueTitle();

    await alertOps({ title, severity: 'error' }, { store, fetchImpl });
    clock += ALERT_DEDUPE_WINDOW_SECONDS * 1_000 + 1;
    await alertOps({ title, severity: 'error' }, { store, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('deduplicates on severity + title, so a different severity still pages', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    const store = createInMemoryAlertDedupeStore();
    const fetchImpl = vi.fn(async () => jsonResponse());
    const title = uniqueTitle();

    await alertOps({ title, severity: 'warning' }, { store, fetchImpl });
    await alertOps({ title, severity: 'critical' }, { store, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pins the dedupe window at 300 seconds', () => {
    expect(ALERT_DEDUPE_WINDOW_SECONDS).toBe(300);
  });
});

describe('delivery failures are swallowed', () => {
  it('posts the Slack-compatible payload with a timeout signal and resolves', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    const store = createInMemoryAlertDedupeStore();
    const fetchImpl = vi.fn(async () => jsonResponse());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const title = uniqueTitle();

    await expect(alertOps({ title, severity: 'error', detail: { route: '/api/v1/x' } }, { store, fetchImpl })).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example.invalid/services/T000/B000');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(String(init.body)).toContain(title);
    expect(init.signal).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('resolves when fetch itself rejects', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      alertOps({ title: uniqueTitle(), severity: 'critical' }, { fetchImpl, store: createInMemoryAlertDedupeStore() }),
    ).resolves.toBeUndefined();
  });

  it('resolves on a non-2xx response without retrying', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => jsonResponse(500));

    await expect(
      alertOps({ title: uniqueTitle(), severity: 'error' }, { fetchImpl, store: createInMemoryAlertDedupeStore() }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('delivers even when the dedupe store itself throws', async () => {
    process.env[OPS_ALERT_WEBHOOK_ENV] = 'https://hooks.example.invalid/services/T000/B000';
    const brokenStore: AlertDedupeStore = {
      async claim() {
        throw new Error('redis is down');
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse());

    await expect(
      alertOps({ title: uniqueTitle(), severity: 'error' }, { fetchImpl, store: brokenStore }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds the delivery POST with a timeout', () => {
    expect(ALERT_POST_TIMEOUT_MS).toBe(3_000);
  });
});
