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
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
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
    // Fail OPEN on infrastructure failure would be unsafe for auth; fail CLOSED
    // with a conservative allowance so a Redis outage cannot be used as a
    // rate-limit bypass.
    return { allowed: false, remaining: 0, resetSeconds: windowSeconds, limit };
  }
}

/** Convenience wrapper used by the IPN webhook replay guard. */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const res = await redis.set(rkey('once', key), '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch {
    return false;
  }
}
