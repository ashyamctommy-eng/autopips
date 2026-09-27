import { serverEnv } from '@/lib/env';
import { getSetting } from '@/server/modules/settings/settings.service';

/**
 * Twelve Data transport — the ONE place a Twelve Data HTTP call is made.
 *
 * WHY A CLIENT AND NOT A `fetch` PER CALLER
 * -----------------------------------------
 * The free/Basic plan allows **8 API credits per minute**. Every catalog read, price
 * quote and candle request spends credits, and a naive implementation (a `fetch`
 * in each screen or timer) trips `429 Too Many Requests` the moment two pages
 * load together. That failure is not cosmetic: a 429 during a price read on the
 * position engine is a tick the platform never sees.
 *
 * So this module owns three things:
 *
 *   1. A CREDIT LIMITER. A sliding 60-second window counts CREDITS (not calls —
 *      a batch `/price?symbol=A,B,C` spends one credit per symbol, which is what
 *      the vendor meters). When the next request would exceed the budget, the
 *      caller WAITS rather than being rejected. Requests are serialised through a
 *      single promise chain so concurrent callers cannot both observe "budget
 *      free" and race past the limiter.
 *
 *   2. A TTL CACHE. Catalog data changes rarely (an hour is generous), quotes
 *      change constantly (seconds), candles somewhere between. Callers declare a
 *      TTL; identical requests inside it are served from memory and spend ZERO
 *      credits. This is what makes catalog exploration affordable on the free tier.
 *
 *   3. A 429 BACKOFF. If the vendor still answers 429 (another process, a shared
 *      key, a clock skew), the client waits out the window and retries ONCE, then
 *      surfaces the error. It never hot-loops.
 *
 * The API key is NEVER logged and never placed in a returned error message.
 */

/** Basic/free plan budget. Higher plans can raise this via env if ever needed. */
export const TWELVE_DATA_CREDITS_PER_MINUTE = 8;
const WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface TwelveDataFetchDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchJson: (url: string) => Promise<unknown>;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

let creditWindow: number[] = [];
let chain: Promise<unknown> = Promise.resolve();
const cache = new Map<string, CacheEntry>();
const counters = { requests: 0, cacheHits: 0, waits: 0, rateLimitBackoffs: 0 };

/** Observability + test surface. */
export function twelveDataClientStats(): {
  requests: number;
  cacheHits: number;
  waits: number;
  rateLimitBackoffs: number;
  creditsInWindow: number;
  cachedKeys: number;
} {
  return { ...counters, creditsInWindow: creditWindow.length, cachedKeys: cache.size };
}

/** Test-only: clear limiter, cache and counters. */
export function resetTwelveDataClientForTests(): void {
  creditWindow = [];
  chain = Promise.resolve();
  cache.clear();
  counters.requests = 0;
  counters.cacheHits = 0;
  counters.waits = 0;
  counters.rateLimitBackoffs = 0;
}

/** Effective key: Admin → Settings override, else the env var. */
export function twelveDataApiKey(): string {
  return getSetting('twelve_data.api_key').trim();
}

/* ────────────────────────────── rate limiting ────────────────────────────── */

/**
 * Reserve `credits` against the sliding window, sleeping until they fit.
 *
 * Called only from inside the serialised chain, so the window cannot be observed
 * and mutated by two callers at once.
 */
async function reserveCredits(credits: number, deps: TwelveDataFetchDeps): Promise<void> {
  for (;;) {
    const now = deps.now();
    while (creditWindow.length > 0 && creditWindow[0] <= now - WINDOW_MS) creditWindow.shift();

    if (creditWindow.length + credits <= TWELVE_DATA_CREDITS_PER_MINUTE) {
      for (let i = 0; i < credits; i += 1) creditWindow.push(now);
      return;
    }

    // GUARD: if the window is empty and the request still does not fit, waiting
    // can never help — the request alone exceeds the whole budget. Looping here
    // is an infinite tight loop (found by live testing), so fail loudly instead
    // and let the caller batch. `claimOnceDurable`'s lesson applies: an
    // unevaluable guard must never spin silently.
    if (creditWindow.length === 0) {
      throw new Error(
        `Twelve Data: a request costing ${credits} credits cannot fit the ${TWELVE_DATA_CREDITS_PER_MINUTE}-credit budget. Split it into smaller batches.`,
      );
    }

    // Wait until the oldest credit in the window expires, plus a small cushion.
    const waitMs = Math.max(50, creditWindow[0] + WINDOW_MS - now + 25);
    if (!Number.isFinite(waitMs)) {
      throw new Error('Twelve Data: credit limiter computed an invalid wait; refusing to spin.');
    }
    counters.waits += 1;
    await deps.sleep(waitMs);
  }
}

/* ─────────────────────────────── transport ───────────────────────────────── */

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      // 429 must be distinguishable so the caller can back off.
      throw new Error(`Twelve Data answered HTTP ${response.status}.`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function defaultDeps(timeoutMs: number): TwelveDataFetchDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchJson: (url) => fetchJsonWithTimeout(url, timeoutMs),
  };
}

/** True when a payload is the vendor's rate-limit error. */
export function isTwelveRateLimitPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>;
  if (body.code === 429) return true;
  return typeof body.message === 'string' && /too many requests|rate limit/i.test(body.message);
}

/** The vendor error message from a payload, or null when it is not an error. */
export function twelveDataErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  const isError = body.status === 'error' || typeof body.code === 'number';
  if (!isError) return null;
  return typeof body.message === 'string' ? body.message : 'unknown error';
}

export function buildTwelveDataUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  query.set('apikey', apiKey);
  return `${base}/${path.replace(/^\/+/, '')}?${query.toString()}`;
}

export interface TwelveDataFetchOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Credits this request spends. A batch price call is one credit per symbol. */
  credits?: number;
  /** Serve repeat requests from memory for this long. 0 disables caching. */
  ttlSeconds?: number;
  /**
   * Per-request timeout. Catalogs are large (the ETF list is tens of thousands
   * of rows) and are cached for an hour, so a longer budget there is right; a
   * price read should stay snappy.
   */
  timeoutMs?: number;
  deps?: Partial<TwelveDataFetchDeps>;
}

/**
 * Fetch a Twelve Data endpoint, respecting the credit budget and the cache.
 *
 * @throws when the key is missing, the vendor rejects the request, or the network
 *         fails after the single rate-limit retry. The message never contains the key.
 */
export async function twelveDataFetch<T>(
  path: string,
  params: Record<string, string | number> = {},
  options: TwelveDataFetchOptions = {},
): Promise<T> {
  const apiKey = (options.apiKey ?? twelveDataApiKey()).trim();
  if (apiKey.length === 0) {
    throw new Error(
      'Twelve Data is not configured: set TWELVE_DATA_API_KEY or the twelve_data.api_key setting.',
    );
  }

  const deps: TwelveDataFetchDeps = {
    ...defaultDeps(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ...options.deps,
  };
  const credits = Math.max(1, Math.trunc(options.credits ?? 1));
  if (!Number.isFinite(credits) || credits < 1) {
    throw new Error('Twelve Data: credits must be a positive finite number.');
  }
  if (credits > TWELVE_DATA_CREDITS_PER_MINUTE) {
    throw new Error(
      `Twelve Data: a request costing ${credits} credits exceeds the ${TWELVE_DATA_CREDITS_PER_MINUTE}-credit budget; batch it.`,
    );
  }
  const ttlMs = Math.max(0, (options.ttlSeconds ?? 0) * 1000);

  // Cache key excludes the API key on purpose (never key a cache by a secret).
  const cacheKey = `${path}?${new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString()}`;

  if (ttlMs > 0) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > deps.now()) {
      counters.cacheHits += 1;
      return hit.value as T;
    }
    if (hit) cache.delete(cacheKey);
  }

  const run = async (): Promise<T> => {
    const url = buildTwelveDataUrl(
      options.baseUrl ?? serverEnv().TWELVE_DATA_API_BASE,
      path,
      params,
      apiKey,
    );

    await reserveCredits(credits, deps);
    counters.requests += 1;

    let payload: unknown;
    try {
      payload = await deps.fetchJson(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimited = /HTTP 429/.test(message) || /too many requests/i.test(message);
      if (!isRateLimited) throw err;

      // ONE backoff-and-retry: wait out the window, re-reserve, try again.
      counters.rateLimitBackoffs += 1;
      await deps.sleep(WINDOW_MS);
      await reserveCredits(credits, deps);
      counters.requests += 1;
      payload = await deps.fetchJson(url);
    }

    if (isTwelveRateLimitPayload(payload)) {
      counters.rateLimitBackoffs += 1;
      await deps.sleep(WINDOW_MS);
      await reserveCredits(credits, deps);
      counters.requests += 1;
      payload = await deps.fetchJson(url);
    }

    const errorMessage = twelveDataErrorMessage(payload);
    if (errorMessage !== null) {
      // Never echo the URL: it carries the key.
      throw new Error(`Twelve Data rejected ${path}: ${errorMessage}`);
    }

    if (ttlMs > 0) cache.set(cacheKey, { expiresAt: deps.now() + ttlMs, value: payload });
    return payload as T;
  };

  // Serialise: the limiter's view of the window must be exclusive.
  const queued = chain.then(run, run);
  chain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
