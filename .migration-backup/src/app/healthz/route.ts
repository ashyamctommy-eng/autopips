import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { readBotRuntimeHeartbeat } from '@/server/modules/bot/bot.runtime.state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /healthz — the LIVENESS endpoint.
 *
 * WHY THIS EXISTS ALONGSIDE /api/v1/health
 *   Two different questions, deliberately answered by two endpoints:
 *
 *     /healthz          "is this process up and serving HTTP?"  → always 200
 *     /api/v1/health     "can it serve traffic correctly?"       → 503 when not
 *
 *   Managed hosts (Railway, Kubernetes, Fly) use a liveness probe to decide
 *   whether to RESTART a container, and a readiness probe to decide whether to
 *   route traffic to it. Collapsing them into one fail-closed check is what makes
 *   a deployment flap: a brief dependency blip restarts a process that was
 *   recovering fine. So this endpoint is honest about what it observes and still
 *   answers 200, while `/api/v1/health` keeps the hard 503 gate for external
 *   READINESS monitors. Railway's own `healthcheckPath` points HERE (see
 *   railway.toml) — a Redis blip must not pull every web replica out of rotation
 *   or fail an otherwise-good deploy; a genuinely unmigrated database is still
 *   caught by the image entrypoint's `prisma migrate deploy`.
 *
 * `service` NAMES THE TIER THAT ANSWERED. That field is the cheapest possible fix
 * for the failure this platform actually hit: a worker service that was built
 * from the WEB image answered `/healthz` with an HTML 404 for weeks, and a
 * misconfigured service running this route would now announce `"service": "web"`
 * where a worker is expected — instead of looking healthy and trading nothing.
 *
 * The `trading` block is read from Redis, not from memory, so this endpoint tells
 * the same truth whether it is answered by a worker or by a web replica that has
 * never run the bot loop. It is `null` when the heartbeat is absent, which is
 * itself the signal that no worker is publishing.
 *
 * Exposes no hostnames, versions, timings or error strings.
 */

const PROBE_TIMEOUT_MS = 4000;

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS),
    ),
  ]);
}

async function probeDb(): Promise<'ok' | 'error'> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`);
    return 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Is the database MIGRATED, not merely reachable? An empty database answers
 * `SELECT 1` perfectly and then 500s on every page — the 2026-09-24 incident.
 */
async function probeSchema(): Promise<'ok' | 'error'> {
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<Array<{ table: string | null }>>`SELECT to_regclass('public."TradingPlan"')::text AS table`,
    );
    return rows[0]?.table ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

async function probeRedis(): Promise<'ok' | 'error'> {
  try {
    const pong = await withTimeout(redis.ping());
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export async function GET() {
  const [db, redisStatus, schema, heartbeat] = await Promise.all([
    probeDb(),
    probeRedis(),
    probeSchema(),
    // Never throws: an absent/unreadable heartbeat returns null, which is the
    // correct answer rather than an error on a liveness probe.
    readBotRuntimeHeartbeat(),
  ]);

  const live = db === 'ok' && redisStatus === 'ok' && schema === 'ok';

  return NextResponse.json(
    {
      status: live ? 'ok' : 'degraded',
      ok: live,
      service: 'web',
      db,
      redis: redisStatus,
      schema,
      // Cross-process bot truth. `trading: null` means no worker is publishing a
      // heartbeat — the case that used to be indistinguishable from healthy.
      trading: heartbeat
        ? {
            status: 'ok',
            startedAt: heartbeat.startedAt,
            lastCycleAt: heartbeat.lastCycleAt,
            cycleCount: heartbeat.cycleCount,
            intervalSeconds: heartbeat.intervalSeconds,
            enabledStrategies: heartbeat.enabledStrategies,
            heartbeatAgeSeconds: Math.round(heartbeat.ageSeconds),
          }
        : null,
      time: new Date().toISOString(),
    },
    // Liveness: 200 means "this process is serving", not "every dependency is
    // healthy". Readiness gating lives on /api/v1/health.
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
