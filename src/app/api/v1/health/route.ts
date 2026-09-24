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

async function probeRedis(): Promise<'ok' | 'error'> {
  try {
    const pong = await withTimeout(redis.ping());
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export async function GET() {
  const [db, redisStatus] = await Promise.all([probeDb(), probeRedis()]);

  const healthy = db === 'ok' && redisStatus === 'ok';

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
        time: new Date().toISOString(),
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
