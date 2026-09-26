import { createHash } from 'node:crypto';

/**
 * OPERATIONAL ALERTING — dependency-free, environment-gated.
 *
 * WHY THIS EXISTS
 *   Failures in this platform were only ever a `console.error` line and an
 *   `AuditLog` row. Nobody is paged by either, so a flipped kill switch, a
 *   rejected deposit IPN or a bot loop that died after a successful start could
 *   sit unnoticed until a customer complained. This module posts a Slack
 *   incoming-webhook message for the failures that matter — nothing more.
 *
 * WHY NOT SENTRY / OTEL
 *   No DSN is available and we do not want a vendor in the money path right now.
 *   A webhook POST is small enough to own ourselves; when a real backend is
 *   chosen, `alertOps()` is the single call site to replace.
 *
 * THE CONTRACT (also pinned in tests/ops-alert.test.ts)
 *   1. OFF BY DEFAULT. `OPS_ALERT_WEBHOOK_URL` unset (or empty) means this
 *      function is a SILENT NO-OP: no network, no Redis, no throw. That is what
 *      makes this safe to merge before an alert channel exists.
 *   2. NEVER THROWS and never rejects. The body is wrapped in try/catch and the
 *      delivery POST is bounded by `ALERT_POST_TIMEOUT_MS`. Callers use
 *      `void alertOps(...)` — a broken webhook must not turn a handled 500 into a
 *      different failure.
 *   3. NO SECRETS, NO PII. Detail values are passed through `redactDetail()`:
 *      secret-ish KEYS are dropped, and obvious secret/PII shapes inside string
 *      values (connection strings, Bearer tokens, long opaque runs, long digit
 *      runs, email addresses) are scrubbed. The payload must never carry a
 *      token, a full account number, a document body or a webhook URL.
 *   4. DEDUPLICATED per `severity + title` for `ALERT_DEDUPE_WINDOW_SECONDS`, so
 *      an error loop cannot page once per request.
 *
 * SERVER-ONLY: this module uses `node:crypto`. It is imported by
 * `src/lib/http.ts`; do not import it from a client component.
 */

export type OpsAlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface OpsAlertInput {
  /** Stable, human-readable one-liner. IDENTICAL titles dedupe together. */
  title: string;
  severity: OpsAlertSeverity;
  /** Compact structured context. Redacted and size-capped; never the request body. */
  detail?: Record<string, unknown>;
}

/** Slack-compatible body. `text` is the only field Slack requires. */
export interface OpsAlertPayload {
  text: string;
  severity: OpsAlertSeverity;
  title: string;
  detail: Record<string, unknown>;
  timestamp: string;
}

/** Env var read at CALL time (not import time), so tests can toggle it. */
export const OPS_ALERT_WEBHOOK_ENV = 'OPS_ALERT_WEBHOOK_URL';

/**
 * DEDUPE WINDOW — 300 s (5 minutes), keyed on `severity + title`.
 *
 * WHY 5 MINUTES: one bad route in a hot loop throws thousands of times a minute,
 * and an error-path alert that fires per request is worse than no alert (it gets
 * muted). 5 minutes collapses a storm to a single page per distinct failure, and
 * is still short enough that a persistent outage re-pages ~12x/hour — it can be
 * acknowledged but not forgotten. It also spans a rolling deploy, where the same
 * failure appears on the outgoing and incoming replica.
 */
export const ALERT_DEDUPE_WINDOW_SECONDS = 300;

/** Hard cap on the delivery POST. A slow webhook must not pile up timers. */
export const ALERT_POST_TIMEOUT_MS = 3_000;

/**
 * Slack truncates long messages and a giant `detail` would make the alert
 * unreadable on a phone. Serialized detail above this is replaced by a marker.
 */
export const ALERT_DETAIL_MAX_CHARS = 1_800;

const REDACTED = '[redacted]';

/** Whole keys whose value is never sent, whatever its shape. */
const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|cookie|credential|private[-_]?key|mnemonic|seed[-_]?phrase|signature|hmac|ciphertext|cvv|cvc|iban|ssn|account[-_]?number|wallet[-_]?address|webhook)/i;

/**
 * Shape-level scrubbing for STRING values, in order. Numbers that arrive as
 * strings are covered by the digit rule; a real `Error` keeps its message (also
 * scrubbed) because that is usually the whole point of the alert.
 */
const STRING_SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host -> scheme://user:[redacted]@host
  [/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi, `$1:${REDACTED}@`],
  // Bearer <token> / Basic <token>
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // email addresses (PII)
  [/\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  // long opaque runs: API keys, JWTs without dots, hex secrets
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, REDACTED],
  // long digit runs: account / card numbers
  [/\b\d{12,}\b/g, '[redacted-number]'],
];

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) head.push(`... ${value.length - MAX_ARRAY_ITEMS} more`);
    return head;
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[truncated]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Redact a detail object for transport. Exported so the rule is testable on its
 * own; `buildAlertPayload` applies it for you.
 */
export function redactDetail(detail?: Record<string, unknown>): Record<string, unknown> {
  if (!detail) return {};
  return redactValue(detail, 0) as Record<string, unknown>;
}

/**
 * PURE payload builder — no network, no environment. Pins the wire shape so a
 * webhook change is a test change, not a production surprise.
 */
export function buildAlertPayload(input: OpsAlertInput, now: Date = new Date()): OpsAlertPayload {
  const redacted = redactDetail(input.detail);
  const serialized = JSON.stringify(redacted);
  const detail =
    serialized.length > ALERT_DETAIL_MAX_CHARS
      ? { _truncated: `${serialized.slice(0, ALERT_DETAIL_MAX_CHARS)}...` }
      : redacted;

  const compact = JSON.stringify(detail);
  const suffix = compact === '{}' ? '' : ` ${compact}`;

  return {
    text: `[${input.severity.toUpperCase()}] ${input.title}${suffix}`,
    severity: input.severity,
    title: input.title,
    detail,
    timestamp: now.toISOString(),
  };
}

/**
 * Dedupe seam. Production uses Redis (so every web instance shares the window);
 * tests inject the in-process store below, which makes the rule deterministic
 * with or without a live Redis.
 */
export interface AlertDedupeStore {
  /** `true` = first sighting in the window (deliver); `false` = duplicate (drop). */
  claim(dedupeKey: string, windowSeconds: number): Promise<boolean>;
}

/** In-process store: the test seam and the fail-open fallback. */
export function createInMemoryAlertDedupeStore(now: () => number = Date.now): AlertDedupeStore {
  const seen = new Map<string, number>();
  return {
    async claim(dedupeKey, windowSeconds) {
      const current = now();
      const expiresAt = seen.get(dedupeKey);
      if (expiresAt !== undefined && expiresAt > current) return false;
      // Opportunistic sweep so a long-lived process cannot grow unbounded.
      if (seen.size > 1_000) {
        for (const [key, expiry] of seen) if (expiry <= current) seen.delete(key);
      }
      seen.set(dedupeKey, current + windowSeconds * 1_000);
      return true;
    },
  };
}

const memoryFallback = createInMemoryAlertDedupeStore();

/**
 * Redis-backed claim using the same key helper as `src/lib/rate-limit.ts`.
 *
 * NOTE: `rate-limit.ts#claimOnce()` is deliberately NOT used here. It fails
 * CLOSED (returns `false` when Redis errors), which for alerting means silently
 * dropping every page during a Redis outage — the exact moment you need one.
 * This claim fails OPEN: on any Redis problem it falls back to the in-process
 * window, and a missing key is always treated as "deliver".
 */
const redisDedupeStore: AlertDedupeStore = {
  async claim(dedupeKey, windowSeconds) {
    try {
      const { redis, rkey } = await import('@/lib/redis');
      const result = await redis.set(rkey('ops-alert', dedupeKey), '1', 'EX', windowSeconds, 'NX');
      if (result === 'OK') return true;
      if (result === null) return false;
      return memoryFallback.claim(dedupeKey, windowSeconds);
    } catch {
      return memoryFallback.claim(dedupeKey, windowSeconds);
    }
  },
};

function dedupeKey(severity: OpsAlertSeverity, title: string): string {
  return createHash('sha256').update(`${severity}\n${title}`).digest('hex').slice(0, 32);
}

export interface AlertOpsDeps {
  /** Inject to avoid real network I/O in tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inject a deterministic dedupe store in tests. Defaults to the Redis store. */
  store?: AlertDedupeStore;
  /** Inject a clock in tests. */
  now?: () => Date;
}

/**
 * Notify the ops channel. See the contract at the top of this file.
 * Resolves — always — so `void alertOps(...)` is safe from any handler.
 */
export async function alertOps(input: OpsAlertInput, deps: AlertOpsDeps = {}): Promise<void> {
  const url = (process.env[OPS_ALERT_WEBHOOK_ENV] ?? '').trim();
  // (1) OFF BY DEFAULT: no destination configured -> silent no-op. Nothing below
  // runs, so this is safe in dev, in CI and on a deployment that never enables it.
  if (!url) return;

  const payload = buildAlertPayload(input, deps.now?.() ?? new Date());

  const store = deps.store ?? redisDedupeStore;
  try {
    const first = await store.claim(dedupeKey(input.severity, input.title), ALERT_DEDUPE_WINDOW_SECONDS);
    if (!first) return;
  } catch {
    // A broken dedupe store must never swallow the alert; deliver instead.
  }

  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return;

  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), ALERT_POST_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      // One attempt only: a repeated failure consumes the dedupe window for this
      // title rather than hammering a dead webhook from an error loop.
      console.warn(`[ops-alert] webhook rejected: status=${response.status} severity=${input.severity}`);
    }
  } catch (err) {
    // (2) NEVER THROWS. Log the error NAME only — the webhook URL is itself a
    // secret and must not reach the logs.
    console.error(`[ops-alert] delivery failed: ${err instanceof Error ? err.name : 'unknown'} severity=${input.severity}`);
  } finally {
    clearTimeout(timer);
  }
}
