import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `claimOnceDurable` is the fix for two real money-path failures:
 *
 *   • Redis DOWN  → the OLD Redis-only guard failed closed, so a signed deposit
 *     callback was ACKed as a duplicate and the credit was silently dropped.
 *   • Redis FLUSH → the OLD guard forgot, so a re-delivered trade signal could
 *     place a SECOND live broker order.
 *
 * Postgres is now the authority and Redis only accelerates. These tests pin that
 * contract against mocked stores, including the one case that must still fail
 * closed: Postgres itself being unreachable.
 */

const createMany = vi.fn();
const deleteMany = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    idempotencyClaim: {
      createMany: (...args: unknown[]) => createMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    set: (...args: unknown[]) => redisSet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
  rkey: (...parts: Array<string | number>) => ['autopips', ...parts].join(':'),
}));

import { claimOnceDurable } from '@/lib/idempotency';

beforeEach(() => {
  createMany.mockReset();
  deleteMany.mockReset();
  redisSet.mockReset();
  redisDel.mockReset();
});

describe('claimOnceDurable', () => {
  it('claims through Postgres and records the Redis accelerator', async () => {
    redisSet.mockResolvedValue('OK');
    createMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('ipn:p1:finished', 60);

    expect(result.claimed).toBe(true);
    expect(result.authority).toBe('database');
    expect(result.redisUnavailable).toBe(false);
    // Redis was set twice: the pre-filter and the best-effort accelerator. Both
    // are acceptable; the durable row is what decides.
    expect(redisSet).toHaveBeenCalled();
  });

  it('short-circuits on a Redis duplicate without touching Postgres', async () => {
    redisSet.mockResolvedValue(null);

    const result = await claimOnceDurable('ipn:p1:finished', 60);

    expect(result.claimed).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.authority).toBe('redis');
    expect(createMany).not.toHaveBeenCalled();
  });

  it('REDIS DOWN → still claims durably instead of dropping the work', async () => {
    // This is the deposit-credit-loss regression: the old guard returned false
    // here and the callback was discarded.
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    createMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('ipn:p2:finished', 60);

    expect(result.claimed).toBe(true);
    expect(result.authority).toBe('database');
    expect(result.redisUnavailable).toBe(true);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('REDIS DOWN AND the durable row already exists → duplicate, not a second credit', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    createMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });

    const result = await claimOnceDurable('ipn:p3:finished', 60);

    expect(result.claimed).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.authority).toBe('database');
  });

  it('reuses a key once its durable claim has expired', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    createMany
      .mockResolvedValueOnce({ count: 0 }) // a stale row is in the way
      .mockResolvedValueOnce({ count: 1 }); // after the sweep
    deleteMany.mockResolvedValue({ count: 1 });

    const result = await claimOnceDurable('signal-claimed:s1', 60);

    expect(result.claimed).toBe(true);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('POSTGRES DOWN AND no Redis witness → fails CLOSED (never doubles)', async () => {
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    createMany.mockRejectedValue(new Error('P1001 cannot reach database server'));

    const result = await claimOnceDurable('signal-claimed:s2', 60);

    expect(result.claimed).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.authority).toBe('degraded');
    expect(result.databaseUnavailable).toBe(true);
  });
});
