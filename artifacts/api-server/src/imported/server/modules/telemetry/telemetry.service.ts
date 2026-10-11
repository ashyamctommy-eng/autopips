import type { AdminTelemetrySummary } from '@workspace/api-zod';
import { logger } from '../../../../lib/logger';
import { getPlatformLedger, type PlatformLedger } from '../../accounting/ledger';
import { readBotRuntimeHeartbeat } from '../bot/bot.runtime.state';
import { getTelemetryAnalyticsSnapshot, type TelemetryAnalyticsSnapshot } from './telemetry.analytics';
import { readLatestTelemetryEvent } from './telemetry.events';

/** A ledger figure as a 2dp string, or a neutral zero when the ledger was unreadable. */
const money = (value: { toFixed: (dp: number) => string } | undefined): string =>
  value ? value.toFixed(2) : '0.00';

export async function getAdminTelemetrySummary(): Promise<AdminTelemetrySummary> {
  const readCachedEvent = async (type: 'cycle' | 'execution') => {
    try {
      return await readLatestTelemetryEvent(type);
    } catch (err) {
      logger.warn({ err, type }, 'Could not read the latest telemetry event');
      return null;
    }
  };
  /*
   * DEFENSIVE BY DESIGN. This endpoint backs the operations console: a database
   * blip or an empty ledger must degrade to zeros/placeholders THERE, never to a
   * 500 that blanks the whole page. Only the two Prisma reads can reject — the
   * heartbeat and the Redis event reads already fail safe on their own.
   */
  const safeAnalytics = async (): Promise<TelemetryAnalyticsSnapshot> => {
    try {
      return await getTelemetryAnalyticsSnapshot();
    } catch (err) {
      logger.warn({ err }, 'Telemetry analytics unavailable; reporting an empty snapshot');
      return {
        activePlanCount: 0,
        confirmedExecutions: 0,
        closedTrades: 0,
        winRatePct: null,
        strategyPerformance: [],
        latency: { sampleCount: 0, averageMs: null, p95Ms: null },
      };
    }
  };
  const safeLedger = async (): Promise<PlatformLedger | null> => {
    try {
      return await getPlatformLedger();
    } catch (err) {
      logger.warn({ err }, 'Platform ledger unavailable; reporting zeroed financials');
      return null;
    }
  };

  const [analytics, ledger, heartbeat, lastCycle, lastExecution] = await Promise.all([
    safeAnalytics(),
    safeLedger(),
    readBotRuntimeHeartbeat(),
    readCachedEvent('cycle'),
    readCachedEvent('execution'),
  ]);
  const cycle = lastCycle?.type === 'cycle' ? lastCycle : null;
  const execution = lastExecution?.type === 'execution' ? lastExecution : null;

  const intervalSeconds = heartbeat?.intervalSeconds ?? cycle?.intervalSeconds ?? null;
  const heartbeatAgeSeconds =
    heartbeat?.ageSeconds ??
    (cycle ? Math.max(0, (Date.now() - cycle.timestamp.getTime()) / 1000) : null);
  const staleAfterSeconds = intervalSeconds === null ? 90 : Math.max(90, intervalSeconds * 1.5);
  const status =
    heartbeatAgeSeconds === null
      ? 'OFFLINE'
      : heartbeatAgeSeconds > staleAfterSeconds
        ? 'STALE'
        : 'ONLINE';

  const latestExecutionLatencyMs =
    execution?.latencyMs ?? cycle?.latestExecutionLatencyMs ?? null;

  return {
    runtime: {
      status,
      heartbeatAt: heartbeat?.lastCycleAt
        ? new Date(heartbeat.lastCycleAt)
        : (cycle?.timestamp ?? (heartbeat?.startedAt ? new Date(heartbeat.startedAt) : null)),
      cycleCount: heartbeat?.cycleCount ?? cycle?.cycleCount ?? null,
      cycleDurationMs: cycle?.cycleDurationMs ?? null,
      intervalSeconds,
      enabledStrategies: heartbeat?.enabledStrategies ?? cycle?.enabledStrategies ?? [],
      activePlanCount: analytics.activePlanCount,
      tradesExecuted: cycle?.tradesExecuted ?? null,
      latestExecutionLatencyMs,
    },
    financials: {
      activeCapitalUsd: money(ledger?.totalManagedCapital),
      idleBalanceUsd: money(ledger?.idleBalance),
      totalEquityUsd: money(ledger?.totalEquity),
      realizedPnlUsd: money(ledger?.realizedPnL),
      unrealizedPnlUsd: money(ledger?.unrealizedPnL),
    },
    performance: {
      confirmedExecutions: analytics.confirmedExecutions,
      closedTrades: analytics.closedTrades,
      winRatePct: analytics.winRatePct,
      strategyPerformance: analytics.strategyPerformance,
    },
    executionLatency: {
      windowHours: 24,
      sampleCount: analytics.latency.sampleCount,
      averageMs: analytics.latency.averageMs,
      p95Ms: analytics.latency.p95Ms,
    },
  };
}