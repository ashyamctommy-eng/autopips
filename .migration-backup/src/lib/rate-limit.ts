import { redis, rkey } from '@/lib/redis';

/**
 * Redis-backed fixed-window rate limiter.
 *
 * Applied to authentication (brute force), deposit creation (payment-provider
 * abuse) and withdrawal requests (double-spend attempts).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
  limit: number;
  /**
   * True when the decision was made without Redis (the limiter's backing store
   * was unreachable). Set only when the caller opted into `onInfraFailure: 'allow'`.
   */
  degraded?: boolean;
}

export interface RateLimitOptions {
  /**
   * What to do when Redis is unreachable.
   *
   * `fail_closed` (default) refuses the request. Correct for AUTH: a Redis
   * outage must not become a brute-force bypass, and a 429 is a safer answer
   * than an unmetered login form.
   *
   * `allow` lets the request through. Correct for the NOWPayments IPN webhook,
   * where the HMAC signature — not the rate limiter — is the authentication, the
   * body size is capped, and a 429 during a Redis outage makes the provider stop
   * delivering a deposit callback the platform still owes the client.
   */
  onInfraFailure?: 'fail_closed' | 'allow';
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const bucket = rkey('rl', key, Math.floor(Date.now() / (windowSeconds * 1000)));
  try {
    const results = await redis
      .multi()
      .incr(bucket)
      .expire(bucket, windowSeconds)
      .exec();

    const count = Number(results?.[0]?.[1] ?? 1);
    const ttl = await redis.ttl(bucket);

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: ttl > 0 ? ttl : windowSeconds,
      limit,
    };
  } catch {
    if (options.onInfraFailure === 'allow') {
      // Degrade to unmetered for this request. The signature check still runs —
      // the limiter was only ever defence-in-depth for a flood, never the auth.
      console.warn(`[rate-limit] Redis unavailable for "${key}"; allowing (onInfraFailure=allow).`);
      return { allowed: true, remaining: limit, resetSeconds: windowSeconds, limit, degraded: true };
    }

    // Fail CLOSED on infrastructure failure: a Redis outage must not be usable
    // as a rate-limit bypass for authentication or money-request endpoints.
    return { allowed: false, remaining: 0, resetSeconds: windowSeconds, limit };
  }
}

/**
 * Convenience wrapper used by NON-durable single-use claims (fee accrual, the
 * maturity sweep).
 *
 * For a claim that guards money movement — a deposit/payout IPN slot, a trade
 * signal — use `claimOnceDurable` in `src/lib/idempotency.ts` instead: this one
 * lives only in Redis and therefore fails closed when Redis is down. It is kept
 * for callers that already have a database-level guard (a status CAS, a row
 * lock) behind the claim.
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const res = await redis.set(rkey('once', key), '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch {
    return false;
  }
}
