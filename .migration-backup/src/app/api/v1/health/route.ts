import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health
 *
 * Liveness + dependency readiness for the web tier, used as the platform
 * healthcheck (Railway `healthcheckPath`, Kubernetes probes, Uptime monitors).
 *
 * Reported statuses are REAL probe results, never a blanket "ok":
 *   ok        — the dependency answered
 *   error     — the dependency did not answer
 *   skipped   — not configured in this environment
 *
 * Returns 200 only when every configured dependency is reachable, so a platform
 * healthcheck will not route traffic to an instance that cannot serve it.
 *
 * `db` proves the CONNECTION; `schema` proves the MIGRATIONS. They are reported
 * separately because an empty database answers `SELECT 1` perfectly and then
 * 500s on every page — a deployment in exactly that state was promoted as
 * healthy on 2026-09-24 (the app booted, the marketing pages that touch no SQL
 * rendered, and `/api/v1/plans` plus the whole dashboard threw). A migration gate
 * runs in the image entrypoint now; this probe is the second line of defence.
 *
 * Deliberately exposes no versions, hosts, timings or error strings — a health
 * endpoint should confirm reachability without fingerprinting the stack.
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
 * Is the database MIGRATED, not merely reachable?
 *
 * Checks the presence of the core table rather than the `_prisma_migrations`
 * bookkeeping row: a database that was reset out from under the app can still
 * claim a migration history, but it cannot claim a table it does not have.
 * `to_regclass` returns NULL instead of throwing when the relation is absent.
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
  const [db, redisStatus, schema] = await Promise.all([probeDb(), probeRedis(), probeSchema()]);

  const healthy = db === 'ok' && redisStatus === 'ok' && schema === 'ok';

  return NextResponse.json(
    {
      ok: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        // The web tier serves pages and REST; it does not need Redis for every
        // request, but a down Redis means rate-limit and replay guards fail
        // closed, so it is reported and counted as degraded.
        db,
        redis: redisStatus,
        // 'error' here means the server can reach Postgres but the platform
        // tables are missing — the app must not be promoted in that state.
        schema,
        time: new Date().toISOString(),
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
