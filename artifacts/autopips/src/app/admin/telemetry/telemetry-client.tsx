'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDown, ArrowUp, Clock3, RefreshCw, Radio, Search, ShieldCheck,
  TrendingUp, Wifi, WifiOff,
} from 'lucide-react';
import Decimal from 'decimal.js';
import {
  getGetAdminTelemetryLogsQueryKey,
  getGetAdminTelemetrySummaryQueryKey,
  useGetAdminTelemetryLogs,
  useGetAdminTelemetrySummary,
} from '@workspace/api-client-react';
import type {
  AdminTelemetrySummary,
  AdminTelemetryTrade,
  GetAdminTelemetryLogsParams,
} from '@workspace/api-client-react';
import { resolveApiUrl } from '@/lib/api-request';
import { Button } from '@/components/ui/button';

type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';
const PAGE_SIZE = 12;
const metric = (value: number | null | undefined, suffix = '') => value == null ? '—' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}${suffix}`;
const labelForStrategy = (value: string | null | undefined) => {
  if (!value) return 'Unassigned';
  if (value === 'gold-momentum' || value === 'golden_momentum') return 'Golden Momentum';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};
const usd = (value: string | null | undefined, signed = false) => {
  if (value == null || value === '') return '—';
  try {
    const amount = new Decimal(value);
    const [whole, fraction] = amount.abs().toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const prefix = amount.isNegative() ? '-$' : signed && amount.greaterThan(0) ? '+$' : '$';
    return `${prefix}${grouped}.${fraction}`;
  } catch {
    return value;
  }
};
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const localDayBoundary = (value: string, endOfDay = false) => {
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const statusTone = (status: string) => {
  const value = status.toUpperCase();
  if (value === 'ONLINE' || value === 'CLOSED' || value === 'FILLED') return 'good';
  if (value === 'STALE' || value === 'PENDING' || value === 'OPEN') return 'warn';
  return 'bad';
};
const cardClass = 'rounded-xl border border-line/80 bg-base-850/85 shadow-[0_8px_28px_-22px_rgba(12,32,45,.35)]';

function ValueCard({ label, value, footnote, accent = false, testId }: { label: string; value: string; footnote?: string; accent?: boolean; testId: string }) {
  return (
    <article className={`${cardClass} relative min-w-0 overflow-hidden p-4 sm:p-5`}>
      {accent && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-teal-700" />}
      <p className="text-[0.67rem] font-semibold uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className="mt-3 truncate font-mono text-[1.55rem] font-semibold tracking-tight text-base-100 tabular-nums" data-testid={testId}>{value}</p>
      {footnote && <p className="mt-2 text-xs leading-relaxed text-muted">{footnote}</p>}
    </article>
  );
}

function SkeletonBlock() {
  return <div className="animate-pulse rounded-xl border border-line/60 bg-white/70 p-5"><div className="h-3 w-24 rounded bg-base-700/70" /><div className="mt-5 h-8 w-36 rounded bg-base-700/70" /><div className="mt-3 h-3 w-28 rounded bg-base-700/50" /></div>;
}

function RuntimePanel({ summary, stream, onRetry, loading }: { summary?: AdminTelemetrySummary; stream: StreamState; onRetry: () => void; loading: boolean }) {
  const runtime = summary?.runtime;
  const status = runtime?.status ?? 'UNAVAILABLE';
  const badge = statusTone(status);
  return (
    <section className={`${cardClass} overflow-hidden`} aria-labelledby="runtime-title">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line/70 px-5 py-4 sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <Activity aria-hidden className="size-4 text-teal-700" />
            <h2 id="runtime-title" className="text-sm font-semibold tracking-wide text-base-100">Worker runtime</h2>
          </div>
          <p className="mt-1 text-xs text-muted">Heartbeat and cycle telemetry from the live worker.</p>
        </div>
        <div className="flex items-center gap-3">
          <span aria-live="polite" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[0.68rem] font-semibold tracking-[0.1em] ${badge === 'good' ? 'bg-profit/10 text-profit-600' : badge === 'warn' ? 'bg-warn/10 text-warn-600' : 'bg-loss/10 text-loss-600'}`} data-testid="status-worker">
            <span className={`size-1.5 rounded-full ${badge === 'good' ? 'bg-profit' : badge === 'warn' ? 'bg-warn' : 'bg-loss'}`} />
            {status}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted" data-testid="status-stream">
            {stream === 'live' ? <Wifi className="size-3.5 text-profit" /> : <WifiOff className="size-3.5" />}
            {stream === 'live' ? 'Stream live' : stream === 'connecting' ? 'Connecting' : stream === 'reconnecting' ? 'Reconnecting' : 'Stream offline'}
          </span>
        </div>
      </div>
      {summary ? (
        <>
          <div className="grid grid-cols-2 divide-x divide-y divide-line/60 sm:grid-cols-4 sm:divide-y-0">
            {[
              ['Cycle count', metric(runtime?.cycleCount), 'cycle-count'],
              ['Last cycle', metric(runtime?.cycleDurationMs, ' ms'), 'cycle-duration'],
              ['Worker interval', metric(runtime?.intervalSeconds, ' sec'), 'cycle-interval'],
              ['Latest execution', metric(runtime?.latestExecutionLatencyMs, ' ms'), 'latest-execution-latency'],
            ].map(([label, value, id]) => <div className="px-5 py-4" key={id}><p className="text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p><p className="mt-2 font-mono text-lg font-semibold tabular-nums text-base-100" data-testid={`metric-${id}`}>{value}</p></div>)}
          </div>
          <div className="flex flex-col gap-4 border-t border-line/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex flex-wrap gap-x-6 gap-y-3 text-xs">
              <span><span className="text-muted">Heartbeat</span><strong className="ml-2 font-medium text-base-100" data-testid="text-heartbeat">{dateTime(runtime?.heartbeatAt)}</strong></span>
              <span><span className="text-muted">Active plans</span><strong className="ml-2 font-mono font-medium text-base-100" data-testid="metric-active-plans">{metric(runtime?.activePlanCount)}</strong></span>
              <span><span className="text-muted">Accepted orders · last cycle</span><strong className="ml-2 font-mono font-medium text-base-100" data-testid="metric-trades-executed">{metric(runtime?.tradesExecuted)}</strong></span>
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Enabled strategies" data-testid="list-enabled-strategies">
              {(runtime?.enabledStrategies ?? []).length ? runtime!.enabledStrategies.map((strategy) => <span key={strategy} className="rounded-md border border-teal-700/15 bg-teal-700/[0.06] px-2 py-1 text-[0.68rem] font-medium text-teal-800">{labelForStrategy(strategy)}</span>) : <span className="text-xs text-muted">No enabled strategies reported</span>}
            </div>
          </div>
        </>
      ) : loading ? <div className="grid grid-cols-2 gap-4 px-5 py-6 sm:grid-cols-4" aria-label="Loading worker telemetry">{[1, 2, 3, 4].map((item) => <div key={item} className="h-12 animate-pulse rounded bg-base-700/50" />)}</div> : <div className="flex items-center justify-between px-5 py-6"><p className="text-sm text-muted">Runtime telemetry is unavailable.</p><Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry-runtime"><RefreshCw />Retry</Button></div>}
    </section>
  );
}

function TradeRow({ trade, index }: { trade: AdminTelemetryTrade; index: number }) {
  const pnl = Number(trade.userPnlUsd);
  const pnlClass = pnl > 0 ? 'text-profit-600' : pnl < 0 ? 'text-loss-600' : 'text-base-100';
  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-teal-800/[0.025]">
      <td className="whitespace-nowrap px-4 py-3.5">
        <div className="font-medium text-base-100">{trade.instrument}</div>
        <div className="mt-1 text-[0.68rem] text-muted">{labelForStrategy(trade.strategyId)}</div>
      </td>
      <td className="whitespace-nowrap px-4 py-3.5">
        <span className={`inline-flex items-center gap-1 text-xs font-semibold ${trade.direction.toUpperCase() === 'BUY' || trade.direction.toUpperCase() === 'LONG' ? 'text-profit-600' : 'text-loss-600'}`}>
          {trade.direction.toUpperCase() === 'BUY' || trade.direction.toUpperCase() === 'LONG' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}{trade.direction}
        </span>
        <div className="mt-1 text-xs text-muted">{trade.volume} units</div>
      </td>
      <td className="whitespace-nowrap px-4 py-3.5 text-xs">
        <span className={`rounded-full px-2 py-1 text-[0.65rem] font-semibold ${statusTone(trade.status) === 'good' ? 'bg-profit/10 text-profit-600' : statusTone(trade.status) === 'warn' ? 'bg-warn/10 text-warn-600' : 'bg-loss/10 text-loss-600'}`}>{trade.status}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3.5 font-mono text-xs tabular-nums text-base-100">{usd(trade.entryPrice)}<span className="px-1 text-muted">/</span>{usd(trade.exitPrice)}</td>
      <td className={`whitespace-nowrap px-4 py-3.5 text-right font-mono text-xs font-semibold tabular-nums ${pnlClass}`} data-testid={`value-trade-pnl-${index}`}>{usd(trade.userPnlUsd, true)}</td>
      <td className="whitespace-nowrap px-4 py-3.5 text-xs text-base-100" title={`Opened ${dateTime(trade.openedAt)} · requested ${dateTime(trade.executionRequestedAt)} · broker confirmed ${dateTime(trade.executionCompletedAt)}`}>
        <div>{dateTime(trade.openedAt)}</div>
        <div className="mt-1 text-[0.65rem] text-muted">Request {dateTime(trade.executionRequestedAt)}</div>
        <div className="text-[0.65rem] text-muted">Confirmed {dateTime(trade.executionCompletedAt)}</div>
      </td>
      <td className="max-w-[13rem] truncate px-4 py-3.5 text-xs text-muted" title={trade.userEmail}>{trade.userEmail}</td>
      <td className="whitespace-nowrap px-4 py-3.5 font-mono text-xs tabular-nums text-muted">{metric(trade.executionLatencyMs, ' ms')}</td>
    </tr>
  );
}

export default function TelemetryClient() {
  const queryClient = useQueryClient();
  const summaryQuery = useGetAdminTelemetrySummary({
    query: { queryKey: getGetAdminTelemetrySummaryQueryKey(), refetchInterval: 15000 },
    request: { credentials: 'include' },
  });
  const [page, setPage] = useState(1);
  const [strategy, setStrategy] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [stream, setStream] = useState<StreamState>('connecting');
  const [lastEvent, setLastEvent] = useState<{ type: string; timestamp: string } | null>(null);
  const everConnected = useRef(false);
  const summaryEnvelope = summaryQuery.data;
  const summary = summaryEnvelope?.ok ? summaryEnvelope.data : undefined;
  const params = useMemo<GetAdminTelemetryLogsParams>(() => {
    const start = from ? localDayBoundary(from) : undefined;
    const end = to ? localDayBoundary(to, true) : undefined;
    return {
      page, pageSize: PAGE_SIZE,
      ...(strategy ? { strategy } : {}),
      ...(status ? { status: status as GetAdminTelemetryLogsParams['status'] } : {}),
      ...(search.trim() ? { q: search.trim() } : {}),
      ...(start ? { from: start.toISOString() } : {}),
      ...(end ? { to: end.toISOString() } : {}),
    };
  }, [page, strategy, status, search, from, to]);
  const logsQuery = useGetAdminTelemetryLogs(params, {
    query: { queryKey: getGetAdminTelemetryLogsQueryKey(params), placeholderData: (previous) => previous },
    request: { credentials: 'include' },
  });
  const logsEnvelope = logsQuery.data;
  const logs = logsEnvelope?.ok ? logsEnvelope.data : undefined;

  useEffect(() => {
    const source = new EventSource(resolveApiUrl('/api/admin/telemetry/stream'), { withCredentials: true });
    setStream('connecting');
    source.onopen = () => {
      if (everConnected.current) {
        setStream('reconnecting');
        void queryClient.invalidateQueries({ queryKey: getGetAdminTelemetrySummaryQueryKey() });
      } else {
        everConnected.current = true;
      }
      setStream('live');
    };
    source.onerror = () => setStream(source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    source.addEventListener('telemetry', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { type?: string; timestamp?: string };
        if (!payload.type) return;
        setLastEvent({ type: payload.type, timestamp: payload.timestamp ?? new Date().toISOString() });
        if (payload.type === 'cycle') {
          void queryClient.invalidateQueries({ queryKey: getGetAdminTelemetrySummaryQueryKey() });
        } else if (payload.type === 'execution') {
          void queryClient.invalidateQueries({ queryKey: getGetAdminTelemetryLogsQueryKey() });
        }
      } catch {
        // Ignore malformed event payloads; the periodic generated query remains authoritative.
      }
    });
    return () => source.close();
  }, [queryClient]);

  useEffect(() => { setPage(1); }, [strategy, status, search, from, to]);
  const financials = summary?.financials;
  const performance = summary?.performance;
  const latency = summary?.executionLatency;
  const winningStrategy = useMemo(() => {
    const items = performance?.strategyPerformance ?? [];
    return [...items].sort((a, b) => Number(b.netPnlUsd) - Number(a.netPnlUsd))[0];
  }, [performance?.strategyPerformance]);
  const goldenMomentum = useMemo(
    () => performance?.strategyPerformance.find((item) =>
      item.strategyId === 'gold-momentum' || item.strategyId === 'golden_momentum',
    ),
    [performance?.strategyPerformance],
  );
  const availableStrategies = useMemo(
    () => [...new Set([
      ...(summary?.runtime.enabledStrategies ?? []),
      ...(performance?.strategyPerformance ?? []).map((item) => item.strategyId),
    ])].sort((a, b) => labelForStrategy(a).localeCompare(labelForStrategy(b))),
    [summary?.runtime.enabledStrategies, performance?.strategyPerformance],
  );
  const totalPages = logs ? Math.max(1, Math.ceil(logs.total / logs.pageSize)) : 1;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-12 pt-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 border-b border-line/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[0.67rem] font-semibold uppercase tracking-[0.19em] text-teal-800"><ShieldCheck className="size-3.5" /> Super Admin / Operations</div>
          <h1 className="text-2xl font-semibold tracking-tight text-base-100 sm:text-[2rem]">Live telemetry</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">Worker health, broker execution latency and ledger-backed trading outcomes.</p>
        </div>
        <div className="flex items-center gap-3">
          {lastEvent && <span className="hidden text-right text-[0.68rem] leading-5 text-muted sm:block" data-testid="text-last-event">Last event <strong className="font-medium text-base-100">{lastEvent.type}</strong><br />{dateTime(lastEvent.timestamp)}</span>}
          <Button variant="outline" size="sm" onClick={() => { void summaryQuery.refetch(); void logsQuery.refetch(); }} data-testid="button-refresh-telemetry"><RefreshCw className={`size-3.5 ${summaryQuery.isFetching ? 'animate-spin' : ''}`} />Refresh</Button>
        </div>
      </header>

      {summaryQuery.isError && !summary ? <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-loss/25 bg-loss/5 px-4 py-3" role="alert" data-testid="error-summary"><p className="text-sm text-loss-600">Telemetry summary could not be loaded. Verify the admin API connection.</p><Button size="sm" variant="outline" onClick={() => void summaryQuery.refetch()} data-testid="button-retry-summary">Retry summary</Button></div> : null}
      {summaryEnvelope && !summaryEnvelope.ok ? <div className="mb-5 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm text-warn-600" role="status">The summary response was incomplete. Showing available execution records.</div> : null}
      {summaryQuery.isLoading ? <section aria-label="Loading telemetry" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{[1, 2, 3, 4].map((n) => <SkeletonBlock key={n} />)}</section> : null}

      <div className="mb-5"><RuntimePanel summary={summary} stream={stream} loading={summaryQuery.isLoading} onRetry={() => void summaryQuery.refetch()} /></div>

      <section aria-label="Financial and execution metrics" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summary ? <>
          <ValueCard label="Active capital" value={usd(financials?.activeCapitalUsd)} testId="metric-active-capital" footnote="Capital in active investments and open positions" accent />
          <ValueCard label="Idle balance" value={usd(financials?.idleBalanceUsd, true)} testId="metric-idle-balance" footnote="Ledger’s signed unallocated balance" />
          <ValueCard label="Total equity" value={usd(financials?.totalEquityUsd)} testId="metric-total-equity" footnote="Platform equity, ledger-derived" />
          <ValueCard label="Realized P&L" value={usd(financials?.realizedPnlUsd, true)} testId="metric-realized-pnl" footnote={`Unrealized ${usd(financials?.unrealizedPnlUsd, true)}`} accent />
        </> : [1, 2, 3, 4].map((n) => <SkeletonBlock key={n} />)}
      </section>

      <section className="mb-7 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <article className={`${cardClass} p-5 sm:p-6`} aria-labelledby="execution-title">
          <div className="flex items-start justify-between gap-3">
            <div><div className="flex items-center gap-2"><Clock3 className="size-4 text-teal-700" /><h2 id="execution-title" className="text-sm font-semibold text-base-100">Execution latency</h2></div><p className="mt-1 text-xs text-muted">Broker acknowledgement · rolling {latency ? `${latency.windowHours}h` : 'window'}</p></div>
            <span className="rounded-full bg-teal-800/[0.06] px-2.5 py-1 text-[0.68rem] text-teal-800">{metric(latency?.sampleCount)} samples</span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="border-l-2 border-teal-700 pl-3"><p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted">Average</p><p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-base-100" data-testid="metric-latency-average">{metric(latency?.averageMs, ' ms')}</p></div>
            <div className="border-l-2 border-amber-600 pl-3"><p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted">95th percentile</p><p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-base-100" data-testid="metric-latency-p95">{metric(latency?.p95Ms, ' ms')}</p></div>
          </div>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-base-700/60" aria-hidden><div className="h-full w-[72%] origin-left animate-[telemetry-scan_4s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-teal-800 to-amber-500 opacity-80" /></div>
        </article>
        <article className={`${cardClass} p-5 sm:p-6`} aria-labelledby="outcomes-title">
          <div className="flex items-center gap-2"><TrendingUp className="size-4 text-teal-700" /><h2 id="outcomes-title" className="text-sm font-semibold text-base-100">Closed-trade outcomes</h2></div>
          <p className="mt-1 text-xs text-muted">Execution records reconciled to user P&L.</p>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div><p className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted">Confirmed executions</p><p className="mt-1 font-mono text-xl font-semibold tabular-nums text-base-100" data-testid="metric-confirmed-executions">{metric(performance?.confirmedExecutions)}</p></div>
            <div><p className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted">Closed trades</p><p className="mt-1 font-mono text-xl font-semibold tabular-nums text-base-100" data-testid="metric-closed-trades">{metric(performance?.closedTrades)}</p></div>
            <div className="text-right"><p className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted">Win rate</p><p className="mt-1 font-mono text-xl font-semibold tabular-nums text-teal-800" data-testid="metric-win-rate">{metric(performance?.winRatePct, '%')}</p></div>
          </div>
          <div className="mt-5 border-t border-line/70 pt-4" data-testid="golden-momentum-performance">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-base-100">Golden Momentum</span>
              {goldenMomentum ? (
                <span className={`font-mono text-xs font-semibold tabular-nums ${Number(goldenMomentum.netPnlUsd) >= 0 ? 'text-profit-600' : 'text-loss-600'}`}>{usd(goldenMomentum.netPnlUsd, true)}</span>
              ) : (
                <span className="text-xs text-muted">No broker-confirmed closed trade history</span>
              )}
            </div>
            {goldenMomentum ? <p className="mt-1 text-[0.68rem] text-muted">{metric(goldenMomentum.closedTrades)} closed trades · {metric(goldenMomentum.winRatePct, '%')} win rate</p> : null}
          </div>
          {winningStrategy ? <div className="mt-5 flex items-center justify-between border-t border-line/70 pt-4 text-xs"><span className="text-muted">Leading strategy · <strong className="font-medium text-base-100">{labelForStrategy(winningStrategy.strategyId)}</strong></span><span className={`font-mono font-semibold tabular-nums ${Number(winningStrategy.netPnlUsd) >= 0 ? 'text-profit-600' : 'text-loss-600'}`}>{usd(winningStrategy.netPnlUsd, true)}</span></div> : <p className="mt-5 border-t border-line/70 pt-4 text-xs text-muted">Strategy outcomes unavailable.</p>}
          {(performance?.strategyPerformance ?? []).length > 0 && <div className="mt-3 max-h-36 space-y-2 overflow-y-auto" aria-label="Strategy performance">
            {performance!.strategyPerformance.map((item, index) => <div key={item.strategyId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-line/50 py-2 text-xs" data-testid={`row-strategy-${index}`}>
              <span className="truncate font-medium text-base-100">{labelForStrategy(item.strategyId)} <span className="ml-1 font-normal text-muted">{metric(item.closedTrades)} trades</span></span>
              <span className="font-mono tabular-nums text-muted">{metric(item.winRatePct, '%')}</span>
              <span className={`text-right font-mono font-semibold tabular-nums ${Number(item.netPnlUsd) >= 0 ? 'text-profit-600' : 'text-loss-600'}`}>{usd(item.netPnlUsd, true)}</span>
            </div>)}
          </div>}
        </article>
      </section>

      <section className={`${cardClass} overflow-hidden`} aria-labelledby="ledger-title">
        <div className="flex flex-col gap-4 border-b border-line/70 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
          <div><div className="flex items-center gap-2"><Radio className="size-4 text-teal-700" /><h2 id="ledger-title" className="text-sm font-semibold text-base-100">Execution ledger</h2></div><p className="mt-1 text-xs text-muted">Broker-confirmed records with user-level outcome and timing.</p></div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <label className="relative"><span className="sr-only">Search instrument or user email</span><Search aria-hidden className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" /><input value={searchValue} onChange={(event) => { setSearchValue(event.target.value); setSearch(event.target.value); }} placeholder="Instrument or user email" className="h-9 w-full rounded-md border border-line bg-white pl-8 pr-3 text-xs text-base-100 outline-none placeholder:text-muted focus:border-teal-700/50 sm:w-52" data-testid="input-ledger-search" /></label>
             <label><span className="sr-only">Filter by strategy</span><select value={strategy} onChange={(event) => setStrategy(event.target.value)} className="h-9 w-full rounded-md border border-line bg-white px-3 text-xs text-base-100 outline-none focus:border-teal-700/50 sm:w-44" data-testid="select-strategy"><option value="">All strategies</option>{availableStrategies.map((item) => <option key={item} value={item}>{labelForStrategy(item)}</option>)}{strategy && !availableStrategies.includes(strategy) ? <option value={strategy}>{labelForStrategy(strategy)}</option> : null}</select></label>
            <label><span className="sr-only">Filter by execution status</span><select value={status} onChange={(event) => setStatus(event.target.value)} className="h-9 w-full rounded-md border border-line bg-white px-3 text-xs text-base-100 outline-none focus:border-teal-700/50 sm:w-36" data-testid="select-status"><option value="">All statuses</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option></select></label>
            <label><span className="sr-only">Executions from date</span><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-base-100 outline-none focus:border-teal-700/50 sm:w-36" data-testid="input-date-from" /></label>
            <label><span className="sr-only">Executions to date</span><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} className="h-9 w-full rounded-md border border-line bg-white px-2 text-xs text-base-100 outline-none focus:border-teal-700/50 sm:w-36" data-testid="input-date-to" /></label>
          </div>
        </div>
        {logsQuery.isError && !logs ? <div className="flex items-center justify-between gap-3 p-6" role="alert" data-testid="error-logs"><p className="text-sm text-loss-600">Execution ledger failed to load.</p><Button size="sm" variant="outline" onClick={() => void logsQuery.refetch()} data-testid="button-retry-ledger">Retry</Button></div> : null}
        {logsQuery.isLoading && !logs ? <div className="space-y-3 p-5" aria-label="Loading execution records">{[1, 2, 3].map((n) => <div key={n} className="h-10 animate-pulse rounded bg-base-700/40" />)}</div> : null}
        {!logsQuery.isError && logs && logs.items.length === 0 ? <div className="px-6 py-14 text-center" data-testid="empty-ledger"><div className="mx-auto flex size-10 items-center justify-center rounded-full bg-teal-800/[0.07]"><Activity className="size-4 text-teal-800" /></div><h3 className="mt-3 text-sm font-semibold text-base-100">No executions match</h3><p className="mt-1 text-xs text-muted">Adjust the filters or search to inspect a different slice of the ledger.</p></div> : null}
        {logs && logs.items.length > 0 ? <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left">
              <thead className="bg-base-900/55 text-[0.62rem] font-semibold uppercase tracking-[0.13em] text-muted"><tr><th scope="col" className="px-4 py-3">Instrument / strategy</th><th scope="col" className="px-4 py-3">Side / volume</th><th scope="col" className="px-4 py-3">Status</th><th scope="col" className="px-4 py-3">Entry / exit</th><th scope="col" className="px-4 py-3 text-right">User P&amp;L</th><th scope="col" className="px-4 py-3">Opened / execution timing</th><th scope="col" className="px-4 py-3">Investor</th><th scope="col" className="px-4 py-3">Latency</th></tr></thead>
              <tbody>{logs.items.map((trade, index) => <TradeRow key={trade.id} trade={trade} index={index} />)}</tbody>
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-line/70 px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p className="text-muted" data-testid="text-ledger-count">Showing {(logs.page - 1) * logs.pageSize + 1}–{Math.min(logs.page * logs.pageSize, logs.total)} of {logs.total} ledger records</p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1 || logsQuery.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))} data-testid="button-ledger-previous">Previous</Button>
              <span className="min-w-16 text-center font-mono tabular-nums text-muted" data-testid="text-ledger-page">{logs.page} / {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages || logsQuery.isFetching} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} data-testid="button-ledger-next">Next</Button>
            </div>
          </div>
        </> : null}
        <div className="flex items-start gap-2 border-t border-line/50 bg-teal-900/[0.025] px-4 py-3 text-[0.68rem] leading-relaxed text-muted sm:px-5"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-teal-800" /><p>Financial figures are sourced from the platform ledger. Idle balance is the ledger’s signed unallocated balance; it is not independently recomputed here. Trade outcomes reflect recorded user P&amp;L.</p></div>
      </section>
    </div>
  );
}