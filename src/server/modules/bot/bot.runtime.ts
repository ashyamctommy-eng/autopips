/**
 * Bot runtime — the supervised loop that actually trades.
 *
 * What it does on every tick (interval = `BROKER_SYNC_INTERVAL` seconds):
 *   1. `runSyncCycle()` — refresh broker snapshots, book positions/deals, roll up
 *      every investment from broker-reported numbers;
 *   2. for each enabled strategy × symbol × live connection: evaluate the rules in
 *      `strategy.engine.ts` against the BROKER's candles and hand any signal to
 *      `order.manager.executeSignal` (risk gate → allocation → orders).
 *
 * SINGLE-WRITER: a Redis lock (`autopips:lock:bot-runtime`, SET NX + TTL, renewed
 * every tick with a compare-and-set) means exactly one replica trades at a time.
 * The runtime REFUSES to start — logging an error — when the lock is held: two
 * runtimes placing the same master signal would double every client's exposure.
 *
 * RECOVERABLE, NOT PERMANENT: losing the lock stops this loop (ticking without it
 * would double exposure) but deliberately leaves NO state behind that would make
 * a later `startBotRuntime()` answer `ALREADY_RUNNING`. The boot supervisor in
 * `src/server/main.ts` retries with backoff after a held-lock refusal and after a
 * lock-lost stop, so a Redis flush, an eviction or a rolling deploy cannot end
 * trading until a human redeploys.
 *
 * CROSS-PROCESS TRUTH: every tick refreshes `autopips:bot:runtime-heartbeat` in
 * Redis. The web replica has an empty in-memory runtime state, so the admin API
 * reads that key (via `readBotRuntimeHeartbeat()`) instead of this module's
 * variables. See `bot.runtime.state.ts`.
 *
 * OPERATIONAL CONFIG, NOT DATA: the `strategies` map below is operator
 * configuration (which symbols/timeframe/periods/lot the master account trades).
 * It is not a signal source and contains no simulated prices, P/L or history —
 * every number the runtime acts on comes from the broker at tick time.
 */

import { randomUUID } from 'node:crypto';
import { serverEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { AUDIT, recordAuditSafe } from '../audit/audit.service';
import {
  clearBotRuntimeHeartbeat,
  readBotRuntimeHeartbeat,
  writeBotRuntimeHeartbeat,
  BOT_RUNTIME_HEARTBEAT_KEY,
  BOT_RUNTIME_LOCK_KEY,
  type BotRuntimeHeartbeat,
  type BotRuntimeHeartbeatRead,
} from './bot.runtime.state';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  investmentRooms,
  makeActivity,
} from '../broker/broker.registry';
import { runSyncCycle } from '../broker/broker.sync';
import { publishActivity } from '@/server/ws/event-bus';
import { executeSignal } from './order.manager';
import { evaluateStrategy, STRATEGY_RULE } from './strategy.engine';
import type { TradeSignal } from './bot.types';

/**
 * Re-exported for callers that historically reached for these through the
 * runtime module. The keys and the heartbeat reader live in
 * `bot.runtime.state.ts` because the web process imports them too, and must not
 * drag Prisma, the broker adapters or the order manager along with them.
 */
export { BOT_RUNTIME_HEARTBEAT_KEY, BOT_RUNTIME_LOCK_KEY, readBotRuntimeHeartbeat };
export type { BotRuntimeHeartbeat, BotRuntimeHeartbeatRead };

/** Lock TTL (seconds) — renewed on every tick; the runtime dies with the process. */
const LOCK_TTL_SECONDS = 60;

/** Minimum interval we allow, so a mis-set env var cannot busy-loop the API. */
const MIN_INTERVAL_SECONDS = 5;

export interface StrategyRuntimeConfig {
  /** Operator switch. Only `true` entries are evaluated. */
  enabled: boolean;
  timeframe: string;
  symbols: string[];
  /** Master-account lot size for signals from this strategy. */
  masterVolume: number;
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  candleCount: number;
  stopLookback?: number;
  rewardRisk?: number;
  /** Optional allow-list of MetaApi account ids; empty/omitted = every connection. */
  brokerAccountIds?: string[];
}

/**
 * Enabled strategies. Operational configuration — set by whoever runs the master
 * account, per deployment. A symbol the broker does not offer simply yields no
 * candles and therefore no signal; nothing is substituted.
 *
 *   rule: see `STRATEGY_RULE` in strategy.engine.ts
 *   risk: every signal still has to pass `risk.engine.ts` (fail-closed) before an
 *         order is built, and `BROKER_RISK_MANAGEMENT_ENABLED` (MetaApi's own
 *         risk-management API) is additional to, never a replacement for, that gate.
 */
export const strategies: Record<string, StrategyRuntimeConfig> = {
  'gold-momentum': {
    enabled: true,
    timeframe: '15m',
    // The BROKER's symbol, verbatim and case-sensitive: Deriv's gold is
    // `frxXAUUSD`. An MT5-style `XAUUSD` is a symbol this broker does not have,
    // so the engine fetched nothing and produced no signal.
    symbols: ['frxXAUUSD'],
    // Master lot size. Size it against the master account's equity and the
    // smallest client capital you accept: the client lot is
    // masterVolume × (client capital / master equity), and an allocation that
    // floors below the symbol's minVolume is skipped rather than rounded up.
    masterVolume: 0.1,
    fastPeriod: 12,
    slowPeriod: 26,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    candleCount: 300,
    stopLookback: 10,
    rewardRisk: 2,
  },
};

export interface BotRuntimeStatus {
  started: boolean;
  /** Why the loop is not trading, or `ALREADY_RUNNING` on a duplicate start. */
  reason?: string;
  intervalSeconds: number;
  enabledStrategies: string[];
  startedAt?: string;
  /** Last COMPLETED cycle, for the admin health screen. */
  lastCycleAt?: string;
  lastCycleError?: string | null;
  /** Completed cycles since this runtime started. */
  cycleCount: number;
  /** A fresh Redis read proved this process still owns the single-writer lock. */
  lockHeld: boolean;
  /** Age of the Redis heartbeat this runtime publishes, or null when absent. */
  heartbeatAgeSeconds: number | null;
}

interface RuntimeState {
  timer: ReturnType<typeof setInterval> | null;
  lockToken: string | null;
  ticking: boolean;
  startedAt: Date | null;
  cycleCount: number;
  lastCycleAt: string | null;
  lastCycleError: string | null;
  /**
   * Current pause/halt reason: null while the loop is running, otherwise
   * `lock-lost`, `requested`, `LOCK_HELD: ...`, etc. This is what a later
   * `startBotRuntime()` must NOT treat as "already running".
   */
  haltReason: string | null;
  intervalSeconds: number;
  enabledStrategies: string[];
  /** Exact JSON last written to the heartbeat key (for compare-and-delete). */
  lastHeartbeatPayload: string | null;
  /** Independent lease-renewal timer — see startLeaseKeeper(). */
  leaseTimer: ReturnType<typeof setInterval> | null;
}

const state: RuntimeState = {
  timer: null,
  lockToken: null,
  ticking: false,
  startedAt: null,
  cycleCount: 0,
  lastCycleAt: null,
  lastCycleError: null,
  haltReason: null,
  intervalSeconds: 0,
  enabledStrategies: [],
  lastHeartbeatPayload: null,
  leaseTimer: null,
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

/** Reads the lock without extending it — used to answer "do we still own it". */
const LOCK_OWNED_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return 1
else
  return 0
end`;

async function releaseLock(): Promise<void> {
  const token = state.lockToken;
  if (!token) return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, BOT_RUNTIME_LOCK_KEY, token);
  } catch (err) {
    console.error('[bot.runtime] failed to release the runtime lock:', err instanceof Error ? err.message : err);
  }
  state.lockToken = null;
}

async function renewLock(): Promise<boolean> {
  const token = state.lockToken;
  if (!token) return false;
  const result = await redis.eval(RENEW_LOCK_SCRIPT, 1, BOT_RUNTIME_LOCK_KEY, token, String(LOCK_TTL_SECONDS));
  return Number(result) === 1;
}

/**
 * `renewLock` that treats an UNREADABLE Redis exactly like a lost lock.
 *
 * This distinction matters more than it looks. Without it a thrown renewal error
 * falls through to `runCycle`'s generic catch, which keeps the loop ticking and
 * even counts the cycle and republishes the heartbeat — i.e. the runtime keeps
 * placing orders while it can no longer prove it owns the single-writer lock, and
 * another replica may already have taken it. A lease we cannot prove we hold is a
 * lease we do not hold.
 */
async function renewLockSafely(): Promise<boolean> {
  try {
    return await renewLock();
  } catch (err) {
    console.error(
      '[bot.runtime] could not renew the runtime lock:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Lease-renewal period: a third of the lock TTL, floored at 5s.
 *
 * WHY A SEPARATE TIMER
 *   `runCycle` renews the lock at the TOP of a cycle. That is not enough on its
 *   own: a cycle that runs longer than LOCK_TTL_SECONDS — a slow Deriv
 *   round-trip, a batch of mirrored orders, a large sync — leaves the key expired
 *   until the next tick, and during that window another replica's `SET NX`
 *   SUCCEEDS. Two runtimes placing the same master signal is the exact failure the
 *   single-writer lock exists to prevent, so the lease is renewed on its own
 *   timer, independent of how long a cycle takes.
 */
const LEASE_RENEW_PERIOD_MS = Math.max(5_000, Math.floor((LOCK_TTL_SECONDS * 1000) / 3));

/** One lease renewal. Stops this loop if the lease cannot be extended. */
async function keepLease(): Promise<void> {
  if (!state.startedAt || !state.lockToken) return;
  const stillOurs = await renewLockSafely();
  if (!stillOurs && state.startedAt) {
    console.error(
      '[bot.runtime] the runtime lease could not be renewed; stopping this loop so the supervisor can take it again.',
    );
    await stopBotRuntime('lease-renewal-failed');
  }
}

/** Starts the independent lease keeper (no-op when one is already running). */
function startLeaseKeeper(): void {
  if (state.leaseTimer) return;
  state.leaseTimer = setInterval(() => {
    void keepLease();
  }, LEASE_RENEW_PERIOD_MS);
}

/**
 * Fresh Redis read of whether this process still owns the lock. Used by
 * `botRuntimeStatus()` so `/healthz` cannot report "ok" from stale memory after
 * the lock was evicted out from under us. An unreadable Redis is NOT ownership:
 * if we cannot prove it, we report false.
 */
async function stillOwnsLock(): Promise<boolean> {
  const token = state.lockToken;
  if (!token) return false;
  try {
    const result = await redis.eval(LOCK_OWNED_SCRIPT, 1, BOT_RUNTIME_LOCK_KEY, token);
    return Number(result) === 1;
  } catch {
    return false;
  }
}

/**
 * Publishes/refreshes the cross-process heartbeat. No-ops once the runtime has
 * stopped, so a cycle finishing after a lock-lost stop cannot resurrect the key
 * the stop just removed.
 */
async function writeHeartbeat(): Promise<void> {
  if (!state.startedAt) return;
  const payload = await writeBotRuntimeHeartbeat({
    startedAt: state.startedAt.toISOString(),
    lastCycleAt: state.lastCycleAt,
    cycleCount: state.cycleCount,
    intervalSeconds: state.intervalSeconds,
    enabledStrategies: [...state.enabledStrategies],
    pid: process.pid,
  });
  if (payload !== null) state.lastHeartbeatPayload = payload;
}

/** Runs one sync + strategy cycle. Never throws. */
async function runCycle(): Promise<void> {
  if (state.ticking) return; // a slow broker call must not stack ticks
  state.ticking = true;
  try {
    const stillOurs = await renewLockSafely();
    if (!stillOurs) {
      console.error('[bot.runtime] lost the runtime lock; another replica owns it — stopping this loop.');
      // Recoverable stop: the supervisor in main.ts will retry `startBotRuntime()`.
      // We keep ticking here would double every client's exposure, so we do not.
      await stopBotRuntime('lock-lost');
      return;
    }

    await runSyncCycle();

    const connections = await prisma.brokerConnection.findMany({ where: { status: 'CONNECTED' } });
    const enabled = Object.entries(strategies).filter(([, config]) => config.enabled);
    const riskManagementEnabled = serverEnv().BROKER_RISK_MANAGEMENT_ENABLED;

    for (const [strategyId, config] of enabled) {
      for (const conn of connections) {
        if (config.brokerAccountIds && config.brokerAccountIds.length > 0 && !config.brokerAccountIds.includes(conn.derivAccountId)) {
          continue;
        }
        const adapter = await ensureBrokerConnected(await getAdapterForConnection(conn));
        for (const symbol of config.symbols) {
          const signal: TradeSignal | null = await evaluateStrategy({
            adapter,
            symbol,
            timeframe: config.timeframe,
            config: {
              strategy: strategyId,
              fastPeriod: config.fastPeriod,
              slowPeriod: config.slowPeriod,
              rsiPeriod: config.rsiPeriod,
              rsiOverbought: config.rsiOverbought,
              rsiOversold: config.rsiOversold,
              candleCount: config.candleCount,
              masterVolume: config.masterVolume,
              stopLookback: config.stopLookback,
              rewardRisk: config.rewardRisk,
            },
          });
          if (!signal) continue;

          await recordAuditSafe({
            action: AUDIT.BOT_SIGNAL_TRIGGERED,
            details: {
              strategy: signal.strategy,
              strategyId,
              signalId: signal.signalId,
              symbol: signal.symbol,
              timeframe: config.timeframe,
              direction: signal.direction,
              masterVolume: signal.masterVolume,
              reason: signal.reason,
              rule: STRATEGY_RULE,
              // MetaApi's own risk-management API is advisory to this internal gate.
              metaApiRiskManagementEnabled: riskManagementEnabled,
            },
          });
          await publishActivity(
            makeActivity(
              'SIGNAL_TRIGGERED',
              `Strategy ${strategyId} signalled ${signal.direction} ${signal.masterVolume} ${signal.symbol} (${config.timeframe}): ${signal.reason}`,
              'info',
              { signalId: signal.signalId, strategyId, symbol: signal.symbol, direction: signal.direction },
              investmentRooms(null),
            ),
          );

          const execution = await executeSignal(signal);
          state.lastCycleError = execution.status === 'REJECTED' ? (execution.reason ?? 'rejected') : null;
        }
      }
    }

    state.lastCycleAt = new Date().toISOString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastCycleError = message;
    console.error('[bot.runtime] cycle failed:', message);
    // One bad connection/strategy must never kill the runtime; the sync cycle
    // already audited per-connection failures, this covers the rest.
    await recordAuditSafe({ action: AUDIT.BROKER_ERROR, details: { phase: 'bot_runtime_cycle', error: message } });
  } finally {
    state.ticking = false;
    // Count and publish only cycles of a runtime that is still alive: a
    // lock-lost cycle has already stopped us and removed the heartbeat.
    if (state.startedAt) {
      state.cycleCount += 1;
      await writeHeartbeat();
    }
  }
}

/** The status fields that do not need a Redis round-trip. */
function snapshotStatus(): Omit<BotRuntimeStatus, 'lockHeld' | 'heartbeatAgeSeconds'> {
  return {
    started: state.startedAt !== null,
    reason: state.haltReason ?? undefined,
    intervalSeconds: state.intervalSeconds,
    enabledStrategies: [...state.enabledStrategies],
    startedAt: state.startedAt?.toISOString(),
    lastCycleAt: state.lastCycleAt ?? undefined,
    lastCycleError: state.lastCycleError,
    cycleCount: state.cycleCount,
  };
}

/**
 * Starts the supervised loop. Returns `{ started: false, reason }` (and logs an
 * error) when the single-writer lock is already held by another replica.
 *
 * A previous lock-lost stop leaves no state behind that would make this return
 * `ALREADY_RUNNING`, so the boot supervisor can call it again and take over once
 * the other replica releases the lock.
 */
export async function startBotRuntime(): Promise<BotRuntimeStatus> {
  if (state.timer || state.startedAt) {
    return { ...(await botRuntimeStatus()), started: true, reason: 'ALREADY_RUNNING' };
  }

  const env = serverEnv();
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, env.BROKER_SYNC_INTERVAL);
  const enabledStrategies = Object.entries(strategies)
    .filter(([, config]) => config.enabled)
    .map(([id]) => id);

  const token = randomUUID();
  const acquired = await redis.set(BOT_RUNTIME_LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired === null) {
    const reason = 'LOCK_HELD: another bot runtime already owns autopips:lock:bot-runtime.';
    console.error(`[bot.runtime] refusing to start — ${reason}`);
    // Record why so /healthz and the admin screen can say "stopped, lock held by
    // another replica" instead of looking like an idle-but-fine platform.
    state.intervalSeconds = intervalSeconds;
    state.enabledStrategies = enabledStrategies;
    state.haltReason = reason;
    return { ...snapshotStatus(), lockHeld: false, heartbeatAgeSeconds: null };
  }

  state.lockToken = token;
  state.startedAt = new Date();
  state.intervalSeconds = intervalSeconds;
  state.enabledStrategies = enabledStrategies;
  state.haltReason = null;
  // Fresh lifetime counters: a restart is a new run, and a stale cycle count
  // would make a runtime that just came back look like it had been ticking.
  state.cycleCount = 0;
  state.lastCycleAt = null;
  state.lastCycleError = null;
  state.lastHeartbeatPayload = null;

  await recordAuditSafe({
    action: AUDIT.BOT_STARTED,
    details: {
      intervalSeconds,
      enabledStrategies,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      metaApiRiskManagementEnabled: env.BROKER_RISK_MANAGEMENT_ENABLED,
      strategies: enabledStrategies.map((id) => ({
        id,
        timeframe: strategies[id]?.timeframe,
        symbols: strategies[id]?.symbols,
        masterVolume: strategies[id]?.masterVolume,
      })),
    },
  });
  console.info(
    `[bot.runtime] started: interval=${intervalSeconds}s strategies=[${enabledStrategies.join(', ')}]`,
  );

  // Heartbeat immediately so a health read between start and the first completed
  // cycle sees a live worker rather than nothing.
  await writeHeartbeat();

  // First cycle immediately, then on the interval. The lease keeper runs on its
  // own timer so a long cycle cannot let the lock expire mid-run.
  startLeaseKeeper();
  void runCycle();
  state.timer = setInterval(() => {
    void runCycle();
  }, intervalSeconds * 1000);

  return botRuntimeStatus();
}

/**
 * Stops the loop and releases the lock (only if this runtime still owns it).
 * An in-flight cycle finishes its current broker call; every order is atomic and
 * audited, so nothing is left half-written.
 *
 * Deliberately RECOVERABLE: it clears the timer, the lock token and `startedAt`
 * and records a reason, so calling `startBotRuntime()` again is always safe — the
 * lock-lost path relies on it. The heartbeat is removed too, but only if it is
 * still the payload this runtime wrote (another replica may already own it).
 */
export async function stopBotRuntime(reason = 'requested'): Promise<BotRuntimeStatus> {
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
  await clearBotRuntimeHeartbeat(state.lastHeartbeatPayload);
  state.lastHeartbeatPayload = null;

  if (wasStarted) {
    await recordAuditSafe({ action: AUDIT.BOT_STOPPED, details: { reason } });
    console.info(`[bot.runtime] stopped (${reason}).`);
  }
  return { ...snapshotStatus(), lockHeld: false, heartbeatAgeSeconds: null };
}

/**
 * Current runtime status, for the admin health screen and `/healthz`.
 *
 * Async because `lockHeld` is a FRESH Redis read of the lock, not a memory flag:
 * after a Redis flush the flag and the truth disagree, and it is the truth an
 * operator needs. `heartbeatAgeSeconds` comes from the published heartbeat.
 */
export async function botRuntimeStatus(): Promise<BotRuntimeStatus> {
  const [lockHeld, heartbeat] = await Promise.all([stillOwnsLock(), readBotRuntimeHeartbeat()]);
  return {
    ...snapshotStatus(),
    lockHeld,
    heartbeatAgeSeconds: heartbeat?.ageSeconds ?? null,
  };
}
