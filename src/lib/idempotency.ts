import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';

/**
 * Durable single-use claims for money-critical work.
 *
 * WHY THIS EXISTS (and why it is not just `claimOnce`)
 * ----------------------------------------------------
 * `claimOnce` in `src/lib/rate-limit.ts` is a Redis `SET NX` and nothing else.
 * That was fine while Redis merely *cached* things, but three callers use a
 * claim as a correctness guard on money:
 *
 *   • the deposit IPN replay guard   (`ipn:<payment_id>:<status>`)
 *   • the payout IPN replay guard    (`payout-ipn:<withdrawalId>:<status>`)
 *   • the trade-signal idempotency guard (`signal-claimed:<signalId>`)
 *
 * For those, Redis is the wrong authority, in both directions:
 *
 *   Redis DOWN  → `claimOnce` catches and returns `false`, which every caller
 *                 interprets as "already processed". A signature-valid deposit
 *                 callback is then answered 200 and the client's credit is
 *                 silently dropped (recoverable only by a manual poll), and a
 *                 payout callback is ignored.
 *   Redis FLUSH → the key is gone, so `SET NX` succeeds again and a re-delivered
 *                 trade signal releases a SECOND live broker order — a real
 *                 position, not a bookkeeping error.
 *
 * So Postgres owns the answer to "has this already happened", and Redis is kept
 * only as a cheap pre-filter. A Redis outage degrades performance, never
 * correctness: the claim still works, it just pays for a row instead of a
 * round-trip to the cache.
 *
 * SEMANTICS
 *   `claimed: true`  → this caller won the slot and must do the work.
 *   `claimed: false` → someone already did it (or is doing it); the caller must
 *                      treat the work as done and NOT repeat it.
 *
 * The one case where the guard cannot be honoured is Postgres itself being
 * unreachable. Then:
 *   • if Redis *did* record the claim, the work proceeds (Redis is a witness);
 *   • otherwise the claim FAILS CLOSED. This asymmetry is deliberate: a lost
 *     deposit callback is recoverable and a lost signal can be re-run, but a
 *     double credit and a duplicate live order are not.
 */

export type ClaimAuthority = 'redis' | 'database' | 'degraded';

export interface ClaimResult {
  /** True when this caller won the single-use slot. */
  claimed: boolean;
  /** True when the slot was already taken (the normal "replay" answer). */
  duplicate: boolean;
  /** Where the decision was actually made. `degraded` means both stores were unavailable. */
  authority: ClaimAuthority;
  /** True when Redis could not be reached for this claim. */
  redisUnavailable: boolean;
  /** True when Postgres could not be reached for this claim. */
  databaseUnavailable: boolean;
}

function redisKey(key: string): string {
  return rkey('once', key);
}

/**
 * Claim a single-use slot, backed by Postgres and accelerated by Redis.
 *
 * @param key       Caller-namespaced key, e.g. `ipn:<paymentId>:<status>`.
 * @param ttlSeconds How long the claim is binding. Also bounds the row lifetime.
 */
export async function claimOnceDurable(key: string, ttlSeconds: number): Promise<ClaimResult> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // (1) Redis pre-filter. A *present* key is a definitive duplicate and lets us
  // skip the database entirely; a successful SET is only a hint, never the
  // final answer, because a previous claim may have been written while Redis was
  // down (so the key would be absent even though the work was already done).
  let redisUnavailable = false;
  let redisSawDuplicate = false;
  try {
    const set = await redis.set(redisKey(key), '1', 'EX', ttlSeconds, 'NX');
    redisSawDuplicate = set === null;
  } catch {
    redisUnavailable = true;
  }

  if (redisSawDuplicate) {
    return {
      claimed: false,
      duplicate: true,
      authority: 'redis',
      redisUnavailable: false,
      databaseUnavailable: false,
    };
  }

  // (2) Postgres is the authority.
  try {
    const inserted = await prisma.idempotencyClaim.createMany({
      data: [{ key, expiresAt }],
      skipDuplicates: true,
    });

    if (inserted.count === 1) {
      await bestEffortRedisClaim(key, ttlSeconds);
      return {
        claimed: true,
        duplicate: false,
        authority: 'database',
        redisUnavailable,
        databaseUnavailable: false,
      };
    }

    // Row exists. If it is an expired leftover, sweep it and try exactly once
    // more, so a key can be reused after its TTL without a background sweeper.
    const swept = await prisma.idempotencyClaim.deleteMany({
      where: { key, expiresAt: { lt: new Date() } },
    });
    if (swept.count === 1) {
      const retried = await prisma.idempotencyClaim.createMany({
        data: [{ key, expiresAt }],
        skipDuplicates: true,
      });
      if (retried.count === 1) {
        await bestEffortRedisClaim(key, ttlSeconds);
        return {
          claimed: true,
          duplicate: false,
          authority: 'database',
          redisUnavailable,
          databaseUnavailable: false,
        };
      }
    }

    return {
      claimed: false,
      duplicate: true,
      authority: 'database',
      redisUnavailable,
      databaseUnavailable: false,
    };
  } catch (err) {
    // (3) Postgres unavailable. There is no safe "allow" here: the whole point
    // of the durable row is that it is the authority, and we could not read it.
    // Fail CLOSED so the callers treat the work as already done — the documented
    // recovery path is the reconcile poll (deposits) or an operator re-run
    // (signals), whereas a double credit or a duplicate order has no undo.
    console.error(
      `[idempotency] durable claim failed for "${key}":`,
      err instanceof Error ? err.message : err,
    );

    return {
      claimed: false,
      duplicate: true,
      authority: 'degraded',
      redisUnavailable,
      databaseUnavailable: true,
    };
  }
}

/**
 * Release a claim taken by `claimOnceDurable`.
 *
 * Only used when the guarded work was NOT submitted (e.g. the broker was
 * unreachable before any order was placed), so the same signal can legitimately
 * be retried. Never use this to "un-process" work that has already happened.
 */
export async function releaseClaimDurable(key: string): Promise<void> {
  try {
    await prisma.idempotencyClaim.deleteMany({ where: { key } });
  } catch (err) {
    console.error(
      `[idempotency] failed to release claim "${key}":`,
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await redis.del(redisKey(key));
  } catch {
    // Redis is a cache; the durable row is already gone.
  }
}

/** Populate the Redis pre-filter after a durable claim. Best effort only. */
async function bestEffortRedisClaim(key: string, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(redisKey(key), '1', 'EX', ttlSeconds, 'NX');
  } catch {
    // Absent by design: the durable row is the authority.
  }
}
