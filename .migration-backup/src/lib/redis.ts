import { Redis, type RedisOptions } from 'ioredis';

/**
 * Redis: sessions, rate-limiting, socket room state, and the IPN replay-guard
 * (SETNX on payment_id so a replayed NOWPayments callback is a no-op).
 */

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisSub?: Redis;
};

function buildOptions(): RedisOptions {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const tls = process.env.REDIS_TLS === 'true';
  return {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    ...(tls ? { tls: {} } : {}),
    ...(url ? {} : {}),
  };
}

function create(): Redis {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', buildOptions());
  client.on('error', (err) => {
    // Never crash the process on a transient Redis blip.
    console.error('[redis] error:', err.message);
  });
  return client;
}

export const redis: Redis = globalForRedis.redis ?? create();
/** Separate connection for pub/sub — a subscribed client cannot issue commands. */
export const redisSub: Redis = globalForRedis.redisSub ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
  globalForRedis.redisSub = redisSub;
}

/** Namespaced key helper so environments/tests don't collide. */
export function rkey(...parts: (string | number)[]): string {
  return ['autopips', ...parts].join(':');
}
