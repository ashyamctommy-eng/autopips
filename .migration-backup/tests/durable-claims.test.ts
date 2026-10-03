import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `claimOnceDurable` is the fix for two real money-path failures:
 *
 *   • Redis DOWN  → the OLD Redis-only guard failed closed, so a signed deposit
 *     callback was ACKed as a duplicate and the credit was silently dropped.
 *   • Redis FLUSH → the OLD guard forgot, so a re-delivered trade signal could
 *     place a SECOND live broker order.
 *
 * Postgres is now the SOLE decision-maker (no Redis pre-filter, because a cache
 * that can veto a retry is its own bug). These tests pin the three outcomes —
 * claimed, duplicate, and the `retryable` state introduced after review, which
 * callers must handle as "ask for a redelivery", never as duplicate.
 */

const createMany = vi.fn();
const deleteMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    idempotencyClaim: {
      createMany: (...args: unknown[]) => createMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

import { claimOnceDurable, releaseClaimDurable } from '@/lib/idempotency';

beforeEach(() => {
  createMany.mockReset();
  deleteMany.mockReset();
});

describe('claimOnceDurable', () => {
  it('claims through the durable row', async () => {
    createMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('ipn:p1:finished', 60);

    expect(result).toMatchObject({
      claimed: true,
      duplicate: false,
      retryable: false,
      authority: 'database',
    });
  });

  it('does not consult Redis, so a stale cache entry cannot veto a retry', async () => {
    // Regression guard for the review finding: the previous version set a Redis
    // key BEFORE the durable insert, so a Postgres blip left a key behind that
    // short-circuited every redelivery for the whole TTL. Postgres alone decides
    // now, and a fresh insert still wins.
    createMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('ipn:p2:finished', 60);

    expect(result.claimed).toBe(true);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('reports a claim already taken as a duplicate', async () => {
    createMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });

    const result = await claimOnceDurable('ipn:p3:finished', 60);

    expect(result).toMatchObject({
      claimed: false,
      duplicate: true,
      retryable: false,
      authority: 'database',
    });
  });

  it('reuses a key once its durable claim has expired', async () => {
    createMany
      .mockResolvedValueOnce({ count: 0 }) // a stale row is in the way
      .mockResolvedValueOnce({ count: 1 }); // after the sweep
    deleteMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('signal-claimed:s1', 60);

    expect(result.claimed).toBe(true);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('POSTGRES DOWN → retryable, NOT duplicate (the credit must not be dropped)', async () => {
    createMany.mockRejectedValue(new Error('P1001 cannot reach database server'));

    const result = await claimOnceDurable('ipn:p4:finished', 60);

    expect(result).toMatchObject({
      claimed: false,
      duplicate: false,
      retryable: true,
      authority: 'degraded',
    });
  });

  it('release deletes the durable row so a legitimate retry is not blocked', async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    await releaseClaimDurable('signal-claimed:s2');

    expect(deleteMany).toHaveBeenCalledWith({ where: { key: 'signal-claimed:s2' } });
  });
});
