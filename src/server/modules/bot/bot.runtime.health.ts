/**
 * Pure computation of the `trading` block of `GET /healthz`.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * The three operational defects this fixes all looked "green" on the health
 * endpoint: a worker that never acquired the lock, and a worker whose loop died
 * on lock loss, both served 200 with no way to tell them apart from a healthy
 * one. The decision "is this runtime actually trading" is now a pure function of
 * its status snapshot and the current time, so it can be unit tested without
 * booting a socket server, Prisma or Redis.
 *
 * `src/server/main.ts` owns the HTTP shape and the status codes; this module owns
 * only the verdict.
 */

/** A cycle is "recent" when it completed within this many loop intervals. */
export const TRADING_STALE_INTERVALS = 3;

export type TradingStatusLevel = 'ok' | 'degraded' | 'stopped';

export interface TradingStatusInput {
  /** The loop is running in this process right now. */
  started: boolean;
  /** A fresh read proved this process still owns the single-writer lock. */
  lockHeld: boolean;
  startedAt: string | null;
  /** Last COMPLETED cycle (null before the first one finishes). */
  lastCycleAt: string | null;
  cycleCount: number;
  intervalSeconds: number;
  enabledStrategies: string[];
  /** Why the loop is not trading (lock-lost, requested, LOCK_HELD, ...). */
  reason: string | null;
  /** Age of the Redis heartbeat, or null when it is absent. */
  heartbeatAgeSeconds: number | null;
  /** Injected clock so the function stays pure and testable. */
  nowMs: number;
}

export interface TradingStatus {
  status: TradingStatusLevel;
  started: boolean;
  lockHeld: boolean;
  startedAt: string | null;
  lastCycleAt: string | null;
  secondsSinceLastCycle: number | null;
  cycleCount: number;
  enabledStrategies: string[];
  reason: string | null;
  /** Extra signal beyond the required minimum: how stale the Redis heartbeat is. */
  heartbeatAgeSeconds: number | null;
}

/** Seconds since an ISO timestamp, or null when it is absent/unparseable. */
export function secondsSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  // Clamp: a clock skew that puts the timestamp in the future must not read as
  // a negative age and trick the recency test.
  return Math.max(0, (nowMs - parsed) / 1000);
}

/**
 * Verdict rules:
 *   - `stopped`  — the loop is not running in this process (never acquired the
 *                  lock, lost it, or was stopped). This is the case the old
 *                  `/healthz` could not see at all.
 *   - `degraded` — running but stale, not holding the lock, or no cycle has
 *                  completed yet; ALSO when no strategy is enabled, because a
 *                  runtime with nothing to evaluate cannot place an order and
 *                  reporting `ok` there would be the same "green while not
 *                  trading" lie this block exists to kill. Trading may not be
 *                  happening; a human should look.
 *   - `ok`       — running AND owns the lock AND the last cycle completed within
 *                  ~3 intervals AND at least one strategy is enabled.
 */
export function computeTradingStatus(input: TradingStatusInput): TradingStatus {
  const secondsSinceLastCycle = secondsSince(input.lastCycleAt, input.nowMs);
  const staleAfterSeconds =
    input.intervalSeconds > 0 ? input.intervalSeconds * TRADING_STALE_INTERVALS : null;
  const cycleIsRecent =
    secondsSinceLastCycle !== null &&
    staleAfterSeconds !== null &&
    secondsSinceLastCycle <= staleAfterSeconds;
  const anyStrategyEnabled = input.enabledStrategies.length > 0;

  const status: TradingStatusLevel = !input.started
    ? 'stopped'
    : !anyStrategyEnabled
      ? 'degraded'
      : input.lockHeld && cycleIsRecent
        ? 'ok'
        : 'degraded';

  return {
    status,
    started: input.started,
    lockHeld: input.lockHeld,
    startedAt: input.startedAt,
    lastCycleAt: input.lastCycleAt,
    secondsSinceLastCycle,
    cycleCount: input.cycleCount,
    enabledStrategies: [...input.enabledStrategies],
    reason: input.reason,
    heartbeatAgeSeconds: input.heartbeatAgeSeconds,
  };
}
