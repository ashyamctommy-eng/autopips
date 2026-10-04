import { Redis, type RedisOptions } from 'ioredis';
import { logger } from '../../lib/logger';

/**
 * Redis: sessions, rate-limiting, socket room state, and the IPN replay-guard
 * (SETNX on payment_id so a replayed NOWPayments callback is a no-op).
 */

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisSub?: Redis;
  telemetryRedis?: Redis;
  telemetryRedisSub?: Redis;
};

function buildOptions(url: string): RedisOptions {
  const tls = process.env.REDIS_TLS === 'true';
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    ...(tls ? { tls: {} } : {}),
    ...(url ? {} : {}),
  };
}

function create(url: string, name: string): Redis {
  const client = new Redis(url, buildOptions(url));
  client.on('error', (err) => {
    logger.error({ err, client: name }, 'Redis client error');
  });
  return client;
}

const appRedisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const telemetryRedisUrl = process.env.UPSTASH_REDIS_URL?.trim();

export const redis: Redis = globalForRedis.redis ?? create(appRedisUrl, 'redis');
/** Separate connection for pub/sub — a subscribed client cannot issue commands. */
export const redisSub: Redis = globalForRedis.redisSub ?? create(appRedisUrl, 'redis-sub');

/**
 * Telemetry uses Upstash when configured so API and worker replicas share the
 * same pub/sub channel, while trading locks/sessions retain their existing Redis.
 * Local development falls back to the configured application Redis.
 */
export const telemetryRedis: Redis =
  globalForRedis.telemetryRedis ?? (telemetryRedisUrl
    ? create(telemetryRedisUrl, 'telemetry-redis')
    : redis);
export const telemetryRedisSub: Redis =
  globalForRedis.telemetryRedisSub ?? (telemetryRedisUrl
    ? create(telemetryRedisUrl, 'telemetry-redis-sub')
    : redisSub);

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
  globalForRedis.redisSub = redisSub;
  globalForRedis.telemetryRedis = telemetryRedis;
  globalForRedis.telemetryRedisSub = telemetryRedisSub;
}

/** Namespaced key helper so environments/tests don't collide. */
export function rkey(...parts: (string | number)[]): string {
  return ['autopips', ...parts].join(':');
}
