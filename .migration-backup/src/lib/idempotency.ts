import { prisma } from '@/lib/prisma';

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
 * Redis is the wrong authority for those, in both directions:
 *
 *   Redis DOWN   → `claimOnce` catches and returns `false`, which every caller
 *                  interprets as "already processed". A signature-valid deposit
 *                  callback is then answered 200 and the client's credit is
 *                  silently dropped (recoverable only by a manual poll).
 *   Redis FLUSH  → the key is gone, so `SET NX` succeeds again and a re-delivered
 *                  trade signal releases a SECOND live broker order.
 *
 * DESIGN: POSTGRES IS THE SOLE DECISION-MAKER.
 *   A `IdempotencyClaim` row (primary key = the claim key) is the only thing that
 *   decides whether work has already happened. There is deliberately NO Redis
 *   pre-filter, because a cache that can say "already done" while the durable
 *   record says otherwise is exactly how a lost deposit or a duplicate order
 *   happens: a Redis key set by a failed attempt (or left behind by a partial
 *   release) would veto every retry for the TTL. One indexed insert is cheap for
 *   this traffic, and it is correct in every failure mode.
 *
 * OUTCOMES
 *   claimed: true               → this caller won the slot and must do the work.
 *   duplicate: true             → the work has already been done; do NOT repeat.
 *   retryable: true             → Postgres could not be read, so the claim is
 *                                 UNEVALUABLE. This is neither "done" nor "do
 *                                 it": a caller with a retrying source (a
 *                                 provider webhook) must ask for a redelivery,
 *                                 and a caller without one (a trade signal) must
 *                                 skip the work and say so loudly. Never treat
 *                                 this as duplicate, and never proceed.
 *
 * The distinction matters: inventing a "duplicate" here is what silently drops
 * money, and proceeding unclaimed is what doubles an order.
 */

export interface ClaimResult {
  /** True when this caller won the single-use slot. */
  claimed: boolean;
  /** True when the slot was already taken (the normal "replay" answer). */
  duplicate: boolean;
  /** True when the claim could not be evaluated (Postgres unreachable). */
  retryable: boolean;
  authority: 'database' | 'degraded';
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Delete claims whose TTL has passed.
 *
 * `expiresAt` is indexed, so this is a bounded range delete. It runs at most
 * once per process per `SWEEP_INTERVAL_MS`, fire-and-forget, so a hot claim path
 * never waits on it. Without it, a key that is never claimed again would linger
 * forever; the per-key sweep inside `claimOnceDurable` only handles keys that
 * are reused.
 */
async function sweepExpiredClaims(now: Date): Promise<void> {
  if (now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now.getTime();
  try {
    await prisma.idempotencyClaim.deleteMany({ where: { expiresAt: { lt: now } } });
  } catch (err) {
    // Housekeeping only: never surface this to the claim's caller.
    console.error(
      '[idempotency] expired-claim sweep failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Claim a single-use slot, backed by Postgres.
 *
 * @param key        Caller-namespaced key, e.g. `ipn:<paymentId>:<status>`.
 * @param ttlSeconds How long the claim is binding. Also bounds the row lifetime.
 */
export async function claimOnceDurable(key: string, ttlSeconds: number): Promise<ClaimResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  try {
    const inserted = await prisma.idempotencyClaim.createMany({
      data: [{ key, expiresAt }],
      skipDuplicates: true,
    });

    if (inserted.count === 1) {
      void sweepExpiredClaims(now);
      return { claimed: true, duplicate: false, retryable: false, authority: 'database' };
    }

    // A row already exists. If it is an EXPIRED leftover, sweep it and try
    // exactly once more, so a key can be reused after its TTL. The retry is safe
    // under concurrency: only the caller whose DELETE matched this row's TTL runs
    // it, and the re-insert is primary-key guarded.
    const swept = await prisma.idempotencyClaim.deleteMany({
      where: { key, expiresAt: { lt: now } },
    });
    if (swept.count === 1) {
      const retried = await prisma.idempotencyClaim.createMany({
        data: [{ key, expiresAt }],
        skipDuplicates: true,
      });
      if (retried.count === 1) {
        return { claimed: true, duplicate: false, retryable: false, authority: 'database' };
      }
    }

    return { claimed: false, duplicate: true, retryable: false, authority: 'database' };
  } catch (err) {
    // Postgres is unreachable. There is no safe "allow" here, and it is not a
    // duplicate either: report it as UNEVALUABLE so the caller can choose the
    // right action (ask the provider to redeliver, or skip and alert).
    console.error(
      `[idempotency] durable claim failed for "${key}":`,
      err instanceof Error ? err.message : err,
    );
    return { claimed: false, duplicate: false, retryable: true, authority: 'degraded' };
  }
}

/**
 * Release a claim taken by `claimOnceDurable`.
 *
 * Only used when the guarded work was NOT submitted (e.g. the broker was
 * unreachable before any order was placed), so the same signal can legitimately
 * be retried. Never use this to "un-process" work that has already happened.
 *
 * Not owner-scoped: it deletes by key. That is safe because every caller releases
 * in the same request/turn that took the claim, and the TTL bounds any window.
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
}
