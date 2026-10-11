'use client';

import * as React from 'react';
import { Activity, RefreshCw } from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { SignedUsd, Usd } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { adminRequest, errorMessage } from '@/components/admin/api-client';

/**
 * Admin → Bot control: what the engine is doing right now.
 *
 * Reads `GET /api/v1/admin/bot/status`, which returns the runtime heartbeat plus
 * the latest INVESTMENT-LINKED positions (a client-opened position never appears
 * here). Polled, not streamed: the console already carries the activity feed for
 * the live narrative, and this table is the durable record behind it.
 */

interface RecentExecution {
  investmentId: string | null;
  userEmail: string;
  symbol: string;
  side: string;
  stake: number;
  pnl: number;
  status: string;
  openedAt: string;
  strategyId: string | null;
}

/** A fired signal, or the gate/sizing refusal that explains a fired signal producing nothing. */
interface RecentSignal {
  id: string;
  action: string;
  createdAt: string;
  strategyId: string | null;
  symbol: string | null;
  direction: string | null;
  reason: string | null;
  investmentId: string | null;
}

/** Audit action -> what it means for the operator. */
function signalLabel(action: string): { text: string; tone: 'good' | 'warn' | 'muted' } {
  if (action === 'BOT_SIGNAL_TRIGGERED') return { text: 'signal fired', tone: 'good' };
  if (action === 'RISK_KILL_SWITCH') return { text: 'gated', tone: 'warn' };
  if (action === 'STAKE_ALLOCATED') return { text: 'not sized', tone: 'warn' };
  return { text: action.toLowerCase().replace(/_/g, ' '), tone: 'muted' };
}

interface BotStatusPayload {
  runtime?: {
    workerTrading?: boolean;
    heartbeat?: {
      lastCycleAt?: string | null;
      cycleCount?: number | null;
      intervalSeconds?: number | null;
      enabledStrategies?: string[];
    } | null;
  } | null;
  recentExecutions?: RecentExecution[];
  recentExecutionsError?: string | null;
  recentSignals?: RecentSignal[];
  recentSignalsError?: string | null;
}

const POLL_MS = 15_000;

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

export function BotExecutions() {
  const [data, setData] = React.useState<BotStatusPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const payload = await adminRequest<BotStatusPayload>('/api/v1/admin/bot/status');
      setData(payload);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const heartbeat = data?.runtime?.heartbeat ?? null;
  const executions = data?.recentExecutions ?? [];
  const signals = data?.recentSignals ?? [];

  const columns: DataTableColumn<RecentExecution>[] = [
    {
      key: 'symbol',
      header: 'Instrument',
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium text-base-100">{row.symbol}</span>
          <span className="text-[0.68rem] text-muted">{row.strategyId ?? 'engine'}</span>
        </div>
      ),
    },
    { key: 'side', header: 'Side', cell: (row) => <span className="text-xs">{row.side}</span> },
    {
      key: 'stake',
      header: 'Stake',
      align: 'right',
      cell: (row) => <Usd value={row.stake} tone="neutral" className="text-xs" />,
    },
    {
      key: 'pnl',
      header: 'P/L',
      align: 'right',
      cell: (row) => <SignedUsd value={row.pnl} className="text-xs" />,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'OPEN' ? 'outline' : 'default'}>
          {row.status.toLowerCase()}
        </Badge>
      ),
    },
    {
      key: 'investor',
      header: 'Investor',
      cell: (row) => (
        <span className="text-xs text-muted" title={row.userEmail}>
          {row.userEmail}
        </span>
      ),
    },
    {
      key: 'openedAt',
      header: 'Opened',
      cell: (row) => <span className="text-xs text-muted">{formatTime(row.openedAt)}</span>,
    },
  ];

  const signalColumns: DataTableColumn<RecentSignal>[] = [
    {
      key: 'action',
      header: 'Event',
      cell: (row) => {
        const label = signalLabel(row.action);
        return (
          <Badge variant={label.tone === 'good' ? 'success' : label.tone === 'warn' ? 'warn' : 'outline'}>
            {label.text}
          </Badge>
        );
      },
    },
    {
      key: 'symbol',
      header: 'Instrument',
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium text-base-100">{row.symbol ?? '—'}</span>
          <span className="text-[0.68rem] text-muted">{row.strategyId ?? 'engine'}</span>
        </div>
      ),
    },
    {
      key: 'direction',
      header: 'Side',
      cell: (row) => <span className="text-xs">{row.direction ?? '—'}</span>,
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (row) => (
        <span className="text-xs text-muted" title={row.reason ?? ''}>
          {row.reason ?? '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'When',
      cell: (row) => <span className="text-xs text-muted">{formatTime(row.createdAt)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 p-5 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity aria-hidden className="size-4 text-brand-400" />
            Engine executions
          </CardTitle>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Positions the bot booked against client investments. Every row is money at risk on the
            platform&apos;s own book.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={busy}
          data-testid="button-refresh-executions"
        >
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-5 pt-2">
        <div className="grid gap-3 text-xs sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="uppercase tracking-wide text-muted">Worker trading</span>
            <span className="text-sm text-base-100">
              {data ? (data.runtime?.workerTrading ? 'enabled' : 'paused') : '—'}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="uppercase tracking-wide text-muted">Last cycle</span>
            <span className="text-sm text-base-100">{formatTime(heartbeat?.lastCycleAt)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="uppercase tracking-wide text-muted">Cycle count</span>
            <span className="font-mono text-sm tabular-nums text-base-100">
              {heartbeat?.cycleCount ?? '—'}
            </span>
          </div>
        </div>

        {error ? (
          <p className="text-xs text-loss-600" role="alert">
            {error}
          </p>
        ) : null}
        {data?.recentExecutionsError ? (
          <p className="text-xs text-warn-600">Executions unavailable: {data.recentExecutionsError}</p>
        ) : null}

        <DataTable
          columns={columns}
          rows={executions}
          getRowKey={(row) => `${row.investmentId ?? 'x'}-${row.symbol}-${row.openedAt}`}
          emptyState={
            <EmptyState
              size="sm"
              title="No engine executions yet"
              description="The engine opens a position when a strategy's rule fires. Until then there is nothing on the platform book."
            />
          }
        />

        <div className="flex flex-col gap-2 border-t border-line/60 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-base-100">Signal log</h3>
            <span className="text-xs text-muted">
              Newest first · every fired signal, plus gate and sizing refusals
            </span>
          </div>
          {data?.recentSignalsError ? (
            <p className="text-xs text-warn-600">Signal log unavailable: {data.recentSignalsError}</p>
          ) : null}
          <DataTable
            columns={signalColumns}
            rows={signals}
            getRowKey={(row) => row.id}
            emptyState={
              <EmptyState
                size="sm"
                title="No signals recorded yet"
                description="The engine records a row the moment a rule fires — even when no position follows. An empty log means no setup has triggered, not that tracking is off."
              />
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default BotExecutions;
