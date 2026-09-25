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

/** Redis key holding the single-writer lock. */
export const BOT_RUNTIME_LOCK_KEY = 'autopips:lock:bot-runtime';

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
    symbols: ['XAUUSD'],
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
  reason?: string;
  intervalSeconds: number;
  enabledStrategies: string[];
  startedAt?: string;
  /** Last cycle outcome, for the admin health screen. */
  lastCycleAt?: string;
  lastCycleError?: string;
}

interface RuntimeState {
  timer: ReturnType<typeof setInterval> | null;
  lockToken: string | null;
  ticking: boolean;
  startedAt: Date | null;
  status: BotRuntimeStatus;
}

const state: RuntimeState = {
  timer: null,
  lockToken: null,
  ticking: false,
  startedAt: null,
  status: { started: false, intervalSeconds: 0, enabledStrategies: [] },
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

/** Runs one sync + strategy cycle. Never throws. */
async function runCycle(): Promise<void> {
  if (state.ticking) return; // a slow broker call must not stack ticks
  state.ticking = true;
  try {
    const stillOurs = await renewLock();
    if (!stillOurs) {
      console.error('[bot.runtime] lost the runtime lock; another replica owns it — stopping this loop.');
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
          state.status.lastCycleError = execution.status === 'REJECTED' ? (execution.reason ?? 'rejected') : undefined;
        }
      }
    }

    state.status.lastCycleAt = new Date().toISOString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status.lastCycleError = message;
    console.error('[bot.runtime] cycle failed:', message);
    // One bad connection/strategy must never kill the runtime; the sync cycle
    // already audited per-connection failures, this covers the rest.
    await recordAuditSafe({ action: AUDIT.BROKER_ERROR, details: { phase: 'bot_runtime_cycle', error: message } });
  } finally {
    state.ticking = false;
  }
}

/**
 * Starts the supervised loop. Returns `{ started: false, reason }` (and logs an
 * error) when the single-writer lock is already held by another replica.
 */
export async function startBotRuntime(): Promise<BotRuntimeStatus> {
  if (state.timer || state.startedAt) {
    return { ...state.status, started: true, reason: 'ALREADY_RUNNING' };
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
    state.status = { started: false, reason, intervalSeconds, enabledStrategies };
    return state.status;
  }

  state.lockToken = token;
  state.startedAt = new Date();
  state.status = {
    started: true,
    intervalSeconds,
    enabledStrategies,
    startedAt: state.startedAt.toISOString(),
  };

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

  // First cycle immediately, then on the interval.
  void runCycle();
  state.timer = setInterval(() => {
    void runCycle();
  }, intervalSeconds * 1000);

  return state.status;
}

/**
 * Stops the loop and releases the lock (only if this runtime still owns it).
 * An in-flight cycle finishes its current broker call; every order is atomic and
 * audited, so nothing is left half-written.
 */
export async function stopBotRuntime(reason = 'requested'): Promise<BotRuntimeStatus> {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  await releaseLock();
  const wasStarted = state.startedAt !== null;
  state.startedAt = null;
  state.status = { ...state.status, started: false, reason };

  if (wasStarted) {
    await recordAuditSafe({ action: AUDIT.BOT_STOPPED, details: { reason } });
    console.info(`[bot.runtime] stopped (${reason}).`);
  }
  return state.status;
}

/** Current runtime status, for the admin health screen. */
export function botRuntimeStatus(): BotRuntimeStatus {
  return { ...state.status };
}
