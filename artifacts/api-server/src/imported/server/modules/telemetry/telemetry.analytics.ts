import { Prisma } from '@prisma/client';
import type { AdminTelemetryStrategyPerformance } from '@workspace/api-zod';
import { prisma } from '@/lib/prisma';
import { CLOSED_POSITION_STATUSES } from '../../accounting/ledger';

interface PerformanceAggregateRow {
  isTotal: number;
  strategyId: string | null;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  netPnlUsd: string;
}

interface LatencyAggregateRow {
  sampleCount: number;
  averageMs: number | null;
  p95Ms: number | null;
}

export interface TelemetryAnalyticsSnapshot {
  activePlanCount: number;
  confirmedExecutions: number;
  closedTrades: number;
  winRatePct: number | null;
  strategyPerformance: AdminTelemetryStrategyPerformance[];
  latency: {
    sampleCount: number;
    averageMs: number | null;
    p95Ms: number | null;
  };
}

const ANALYTICS_CACHE_MS = 10_000;
let cachedSnapshot: TelemetryAnalyticsSnapshot | undefined;
let cacheExpiresAt = 0;
let pendingSnapshot: Promise<TelemetryAnalyticsSnapshot> | undefined;

export function telemetryWinRatePct(wins: number, losses: number): number | null {
  const decisiveTrades = wins + losses;
  return decisiveTrades === 0 ? null : Number(((wins / decisiveTrades) * 100).toFixed(2));
}

export function normalizeTelemetryStrategyId(strategyId: string): string {
  const normalized = strategyId.trim().toLowerCase().replaceAll('_', '-');
  return normalized === 'gold-momentum' || normalized === 'golden-momentum'
    ? 'golden_momentum'
    : strategyId;
}

async function queryPerformance(): Promise<{
  closedTrades: number;
  winRatePct: number | null;
  strategyPerformance: AdminTelemetryStrategyPerformance[];
}> {
  const rows = await prisma.$queryRaw<PerformanceAggregateRow[]>`
    WITH closed_rows AS (
      SELECT "strategyId", "netPnL" AS "pnl"
      FROM "TradeRecord"
      WHERE "status" = 'CLOSED'
      UNION ALL
      SELECT NULL::text AS "strategyId", "pnl"
      FROM "Position"
      WHERE "status"::text IN (${Prisma.join([...CLOSED_POSITION_STATUSES])})
    )
    SELECT
      GROUPING("strategyId")::int AS "isTotal",
      "strategyId",
      COUNT(*)::int AS "closedTrades",
      COUNT(*) FILTER (WHERE "pnl" > 0)::int AS "winningTrades",
      COUNT(*) FILTER (WHERE "pnl" < 0)::int AS "losingTrades",
      COALESCE(SUM("pnl"), 0)::text AS "netPnlUsd"
    FROM closed_rows
    GROUP BY GROUPING SETS ((), ("strategyId"))
  `;

  const total = rows.find((row) => row.isTotal === 1);
  const strategies = rows
    .filter((row) => row.isTotal === 0 && row.strategyId !== null)
    .map((row) => ({
      strategyId: normalizeTelemetryStrategyId(row.strategyId as string),
      closedTrades: row.closedTrades,
      winningTrades: row.winningTrades,
      winRatePct: telemetryWinRatePct(row.winningTrades, row.losingTrades),
      netPnlUsd: row.netPnlUsd,
    }))
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId));

  return {
    closedTrades: total?.closedTrades ?? 0,
    winRatePct: telemetryWinRatePct(total?.winningTrades ?? 0, total?.losingTrades ?? 0),
    strategyPerformance: strategies,
  };
}

async function queryExecutionLatency(): Promise<LatencyAggregateRow> {
  const [row] = await prisma.$queryRaw<LatencyAggregateRow[]>`
    SELECT
      COUNT(*)::int AS "sampleCount",
      AVG("executionLatencyMs")::float8 AS "averageMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "executionLatencyMs") AS "p95Ms"
    FROM "TradeRecord"
    WHERE "executionCompletedAt" >= NOW() - INTERVAL '24 hours'
      AND "executionLatencyMs" IS NOT NULL
  `;
  return row ?? { sampleCount: 0, averageMs: null, p95Ms: null };
}

async function loadSnapshot(): Promise<TelemetryAnalyticsSnapshot> {
  const [performance, latency, activePlanCount, confirmedExecutions] = await Promise.all([
    queryPerformance(),
    queryExecutionLatency(),
    prisma.tradingPlan.count({ where: { isActive: true } }),
    prisma.tradeRecord.count(),
  ]);

  return {
    activePlanCount,
    confirmedExecutions,
    ...performance,
    latency: {
      sampleCount: latency.sampleCount,
      averageMs: latency.averageMs,
      p95Ms: latency.p95Ms,
    },
  };
}

/** Shared by the cycle publisher and API; failed reads are never cached. */
export async function getTelemetryAnalyticsSnapshot(): Promise<TelemetryAnalyticsSnapshot> {
  if (cachedSnapshot && Date.now() < cacheExpiresAt) return cachedSnapshot;
  if (pendingSnapshot) return pendingSnapshot;

  pendingSnapshot = loadSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cacheExpiresAt = Date.now() + ANALYTICS_CACHE_MS;
      return snapshot;
    })
    .finally(() => {
      pendingSnapshot = undefined;
    });
  return pendingSnapshot;
}

export function clearTelemetryAnalyticsCache(): void {
  cachedSnapshot = undefined;
  cacheExpiresAt = 0;
}