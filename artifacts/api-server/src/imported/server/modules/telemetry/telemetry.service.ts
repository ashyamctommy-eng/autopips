import type { AdminTelemetrySummary } from '@workspace/api-zod';
import { logger } from '../../../../lib/logger';
import { getPlatformLedger } from '../../accounting/ledger';
import { readBotRuntimeHeartbeat } from '../bot/bot.runtime.state';
import { getTelemetryAnalyticsSnapshot } from './telemetry.analytics';
import { readLatestTelemetryEvent } from './telemetry.events';

export async function getAdminTelemetrySummary(): Promise<AdminTelemetrySummary> {
  const readCachedEvent = async (type: 'cycle' | 'execution') => {
    try {
      return await readLatestTelemetryEvent(type);
    } catch (err) {
      logger.warn({ err, type }, 'Could not read the latest telemetry event');
      return null;
    }
  };
  const [analytics, ledger, heartbeat, lastCycle, lastExecution] = await Promise.all([
    getTelemetryAnalyticsSnapshot(),
    getPlatformLedger(),
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
      activeCapitalUsd: ledger.totalManagedCapital.toFixed(2),
      idleBalanceUsd: ledger.idleBalance.toFixed(2),
      totalEquityUsd: ledger.totalEquity.toFixed(2),
      realizedPnlUsd: ledger.realizedPnL.toFixed(2),
      unrealizedPnlUsd: ledger.unrealizedPnL.toFixed(2),
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