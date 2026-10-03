/**
 * Maturity runtime — the supervised sweep that releases matured capital.
 *
 * Every tick it calls `processMaturedInvestments()`, which transitions any
 * ACTIVE/PAUSED investment whose `maturityDate` has elapsed to MATURED and
 * returns its capital to the client's idle (withdrawable) balance. Until this
 * loop runs, nothing in the codebase can move an investment out of
 * ACTIVE/PAUSED, so a client's principal stays locked forever; this runtime is
 * the thing that makes maturity real.
 *
 * SINGLE-WRITER: a Redis lock (`autopips:lock:maturity-runtime`, DISTINCT from
 * the bot's `autopips:lock:bot-runtime`) acquired with `SET NX EX` and a random
 * token means exactly one replica sweeps at a time. The lock discipline is
 * copied verbatim from `bot.runtime.ts`:
 *   * acquire with `SET key <uuid> EX <ttl> NX`;
 *   * renew with a Lua compare-and-set so only the owner extends the lease;
 *   * release with a Lua compare-and-delete so a replica that lost the lease
 *     cannot delete the new owner's lock;
 *   * an INDEPENDENT lease-renewal timer at one third of the TTL, so a sweep
 *     that runs long cannot let the key expire mid-flight and admit a second
 *     sweeper.
 *
 * The sweep is itself safely idempotent (per-investment claim + DB CAS, see
 * `maturity.service.ts`), so this lock is an efficiency/ordering guard rather
 * than the only thing preventing a double transition. That belt-and-braces is
 * deliberate: this path moves money between the deployed and idle buckets.
 *
 * RECOVERABLE, NOT PERMANENT: losing the lease stops this loop but leaves no
 * state behind that would make a later `startMaturityRuntime()` answer
 * `ALREADY_RUNNING`, so the boot supervisor in `src/server/main.ts` can retry
 * after a Redis flush, an eviction or a rolling deploy.
 *
 * INTERVAL CONFIG: `MATURITY_SWEEP_INTERVAL_SECONDS` is read directly from
 * `process.env` with a validated default rather than being added to
 * `src/lib/env.ts`. `env.ts` is the process's strict boot contract — every key
 * there must be present or the process refuses to start, and it is mirrored in
 * `.env.example` and the deploy docs. A sweep cadence is an operational tuning
 * knob, not a required secret: a missing or malformed value must fall back to
 * 300s and keep sweeping, never stop the worker from booting.
 */

import { randomUUID } from 'node:crypto';

import { redis } from '@/lib/redis';
import { processMaturedInvestments, type MaturitySweepResult } from './maturity.service';

/**
 * Redis key holding the single-writer lock. Deliberately NOT the bot's key:
 * the two runtimes are independent and must be able to run in the same process
 * (and on different replicas) without excluding each other.
 */
export const MATURITY_RUNTIME_LOCK_KEY = 'autopips:lock:maturity-runtime';

/** Lock TTL (seconds) — renewed on every tick and by the lease keeper. */
const LOCK_TTL_SECONDS = 60;

/** Default sweep cadence: every five minutes. */
const DEFAULT_SWEEP_INTERVAL_SECONDS = 300;

/** Floor, so a mis-set env var cannot busy-loop the worker. */
const MIN_SWEEP_INTERVAL_SECONDS = 30;

/** Ceiling: one day. A slower sweep would strand matured capital for too long. */
const MAX_SWEEP_INTERVAL_SECONDS = 86_400;

/**
 * Lease-renewal period: a third of the lock TTL, floored at 5s (same numbers as
 * `bot.runtime.ts`). The renewal MUST be independent of the sweep: if a sweep
 * ever took longer than the TTL, renewing only at the top of a sweep would leave
 * the key expired and another replica could acquire it.
 */
const LEASE_RENEW_PERIOD_MS = Math.max(5_000, Math.floor((LOCK_TTL_SECONDS * 1000) / 3));

/**
 * Resolves the sweep interval from the environment.
 *
 * Reads `process.env` directly (justified in the file header). A non-numeric,
 * empty or absent value falls back to the default; a numeric value is clamped to
 * [MIN, MAX] so a typo cannot disable the sweep or hammer the database.
 */
export function maturitySweepIntervalSeconds(): number {
  const raw = process.env.MATURITY_SWEEP_INTERVAL_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_INTERVAL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SWEEP_INTERVAL_SECONDS;
  return Math.min(MAX_SWEEP_INTERVAL_SECONDS, Math.max(MIN_SWEEP_INTERVAL_SECONDS, Math.floor(parsed)));
}

export interface MaturityRuntimeStatus {
  started: boolean;
  reason?: string;
  intervalSeconds: number;
  startedAt?: string;
  lastSweepAt?: string;
  lastSweepError?: string | null;
  sweepCount: number;
  lastSweep?: MaturitySweepResult;
}

export interface MaturityRuntimeStartResult {
  started: boolean;
  reason?: string;
}

interface MaturityRuntimeState {
  timer: ReturnType<typeof setInterval> | null;
  leaseTimer: ReturnType<typeof setInterval> | null;
  lockToken: string | null;
  sweeping: boolean;
  startedAt: Date | null;
  sweepCount: number;
  lastSweepAt: string | null;
  lastSweepError: string | null;
  lastSweep: MaturitySweepResult | null;
  /**
   * Why the loop is not running. This is what a later `startMaturityRuntime()`
   * must NOT mistake for "already running".
   */
  haltReason: string | null;
  intervalSeconds: number;
}

const state: MaturityRuntimeState = {
  timer: null,
  leaseTimer: null,
  lockToken: null,
  sweeping: false,
  startedAt: null,
  sweepCount: 0,
  lastSweepAt: null,
  lastSweepError: null,
  lastSweep: null,
  haltReason: null,
  intervalSeconds: 0,
};

/** Atomically releases the lock only when this runtime still owns it. */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Atomically extends the TTL only when this runtime still owns the lock. */
const RENEW_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
else
  return 0
end`;

async function releaseLock(): Promise<void> {
  const token = state.lockToken;
  if (!token) return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, MATURITY_RUNTIME_LOCK_KEY, token);
  } catch (err) {
    console.error(
      '[maturity.runtime] failed to release the runtime lock:',
      err instanceof Error ? err.message : err,
    );
  }
  state.lockToken = null;
}

async function renewLock(): Promise<boolean> {
  const token = state.lockToken;
  if (!token) return false;
  const result = await redis.eval(
    RENEW_LOCK_SCRIPT,
    1,
    MATURITY_RUNTIME_LOCK_KEY,
    token,
    String(LOCK_TTL_SECONDS),
  );
  return Number(result) === 1;
}

/**
 * `renewLock` that treats an UNREADABLE Redis exactly like a lost lock. A lease
 * we cannot prove we hold is a lease we do not hold, so the loop stops rather
 * than continuing to mutate money under a lease another replica may own.
 */
async function renewLockSafely(): Promise<boolean> {
  try {
    return await renewLock();
  } catch (err) {
    console.error(
      '[maturity.runtime] could not renew the runtime lock:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** One lease renewal. Stops this loop if the lease cannot be extended. */
async function keepLease(): Promise<void> {
  if (!state.startedAt || !state.lockToken) return;
  const stillOurs = await renewLockSafely();
  if (!stillOurs && state.startedAt) {
    console.error(
      '[maturity.runtime] the runtime lease could not be renewed; stopping this loop so the supervisor can take it again.',
    );
    await stopMaturityRuntime('lease-renewal-failed');
  }
}

/** Starts the independent lease keeper (no-op when one is already running). */
function startLeaseKeeper(): void {
  if (state.leaseTimer) return;
  state.leaseTimer = setInterval(() => {
    void keepLease();
  }, LEASE_RENEW_PERIOD_MS);
}

/** Runs one sweep. Never throws; never stacks ticks. */
async function runSweep(): Promise<void> {
  if (state.sweeping) return;
  state.sweeping = true;
  try {
    const stillOurs = await renewLockSafely();
    if (!stillOurs) {
      console.error(
        '[maturity.runtime] lost the runtime lock; another replica owns it — stopping this loop.',
      );
      // Recoverable stop: the supervisor will retry `startMaturityRuntime()`.
      await stopMaturityRuntime('lock-lost');
      return;
    }

    const result = await processMaturedInvestments();
    state.lastSweep = result;
    state.lastSweepAt = result.ranAt;
    state.lastSweepError = null;
    if (result.matured > 0 || result.refused > 0) {
      console.info(
        `[maturity.runtime] sweep examined=${result.examined} matured=${result.matured} refused=${result.refused} skipped=${result.skipped}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastSweepError = message;
    console.error('[maturity.runtime] sweep failed:', message);
    // One bad sweep must never kill the runtime; the next tick retries.
  } finally {
    state.sweeping = false;
    // Count only sweeps of a runtime that is still alive: a lock-lost sweep has
    // already stopped us and must not advance the counters.
    if (state.startedAt) state.sweepCount += 1;
  }
}

function snapshotStatus(): MaturityRuntimeStatus {
  return {
    started: state.startedAt !== null,
    reason: state.haltReason ?? undefined,
    intervalSeconds: state.intervalSeconds,
    startedAt: state.startedAt?.toISOString(),
    lastSweepAt: state.lastSweepAt ?? undefined,
    lastSweepError: state.lastSweepError,
    sweepCount: state.sweepCount,
    lastSweep: state.lastSweep ?? undefined,
  };
}

/** Current runtime status, for health/admin reads. */
export function maturityRuntimeStatus(): MaturityRuntimeStatus {
  return snapshotStatus();
}

/*
 * The boot supervisor watches a supervised runtime through a named export — see
 * `statusExport` in `RUNTIME_SPECS` (src/server/main.ts), which points at
 * `maturityRuntimeStatus` above. No alias is needed.
 */

/**
 * Starts the supervised sweep. Returns `{ started: false, reason }` (and logs an
 * error) when the single-writer lock is already held by another replica.
 *
 * A previous stop — however it happened — leaves no state behind that would make
 * this return `ALREADY_RUNNING`, so the boot supervisor can call it again and
 * take over once the other replica releases the lock.
 */
export async function startMaturityRuntime(): Promise<MaturityRuntimeStartResult> {
  if (state.timer || state.startedAt) {
    return { started: true, reason: 'ALREADY_RUNNING' };
  }

  const intervalSeconds = maturitySweepIntervalSeconds();

  const token = randomUUID();
  const acquired = await redis.set(MATURITY_RUNTIME_LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired === null) {
    const reason =
      'LOCK_HELD: another maturity runtime already owns autopips:lock:maturity-runtime.';
    console.error(`[maturity.runtime] refusing to start — ${reason}`);
    state.intervalSeconds = intervalSeconds;
    state.haltReason = reason;
    return { started: false, reason };
  }

  state.lockToken = token;
  state.startedAt = new Date();
  state.intervalSeconds = intervalSeconds;
  state.haltReason = null;
  // Fresh lifetime counters: a restart is a new run.
  state.sweepCount = 0;
  state.lastSweepAt = null;
  state.lastSweepError = null;
  state.lastSweep = null;

  console.info(`[maturity.runtime] started: interval=${intervalSeconds}s`);

  // First sweep immediately, then on the interval. The lease keeper runs on its
  // own timer so a long sweep cannot let the lock expire mid-run.
  startLeaseKeeper();
  void runSweep();
  state.timer = setInterval(() => {
    void runSweep();
  }, intervalSeconds * 1000);

  return { started: true };
}

/**
 * Stops the loop and releases the lock (only if this runtime still owns it).
 * Deliberately RECOVERABLE: it clears the timers and the lock token and records a
 * reason, so calling `startMaturityRuntime()` again is always safe — the
 * lock-lost and lease-renewal-failed paths rely on it.
 */
export async function stopMaturityRuntime(reason = 'requested'): Promise<MaturityRuntimeStatus> {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  // Stop the lease keeper BEFORE releasing, so it cannot renew (or race a stop)
  // in the window between the release and `startedAt` being cleared.
  if (state.leaseTimer) {
    clearInterval(state.leaseTimer);
    state.leaseTimer = null;
  }
  const wasStarted = state.startedAt !== null;
  await releaseLock();
  state.startedAt = null;
  state.haltReason = reason;

  if (wasStarted) {
    console.info(`[maturity.runtime] stopped (${reason}).`);
  }
  return snapshotStatus();
}
