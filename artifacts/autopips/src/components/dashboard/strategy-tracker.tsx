'use client';

import * as React from 'react';
import { useRouter } from '@/lib/next/navigation';
import { Activity, Pause, Play, TrendingDown, TrendingUp, Wallet } from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MetricTile } from '@/components/shared/metric-tile';
import { RiskBadge } from '@/components/shared/risk-badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { Pct, SignedUsd, Usd } from '@/components/shared/money';
import { TargetRange } from '@/components/shared/disclaimer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/components/ui/use-toast';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import { apiFetch } from '@/lib/session-refresh';
import { relativeTime } from '@/lib/utils';
import type { InvestmentDetailDTO, InvestmentPositionDTO } from '@/types/api';

/**
 * ACTIVE STRATEGY TRACKER.
 *
 * One investment's live picture: capital deployed, current value and yield, the
 * book of positions the bot engine opened against it, and the controls to pause,
 * resume or close it.
 *
 * LIVE VALUES COME FROM THE SERVER, NOT FROM THE SOCKET PAYLOAD. The engine
 * publishes `account:equity` (scope `investment`) whenever it marks or closes a
 * position; this component treats that as a "re-read" signal and calls
 * `router.refresh()` rather than trusting numbers off the wire — the same rule the
 * dashboard shell follows, and it keeps one source of truth (the ledger) for money.
 */

export interface StrategyTrackerProps {
  investment: InvestmentDetailDTO;
}

/** Pull the server's message out of the `{ ok:false, error }` envelope. */
function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const envelope = body as { ok?: unknown; error?: unknown };
    if (envelope.ok === false) {
      const error = envelope.error as { message?: unknown } | null | undefined;
      if (typeof error?.message === 'string' && error.message.trim() !== '') return error.message;
    }
  }
  return fallback;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

type PendingAction = 'pause' | 'resume' | 'close' | null;

export function StrategyTracker({ investment }: StrategyTrackerProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<PendingAction>(null);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [liveAt, setLiveAt] = React.useState<number | null>(null);

  // Debounced re-read: the engine can mark several positions in a burst.
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEquityEvent = React.useCallback(() => {
    setLiveAt(Date.now());
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 1200);
  }, [router]);
  React.useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const { connected } = useTradingSocket({
    investmentId: investment.id,
    enabled: true,
    onEquityEvent,
  });

  const isPaused = investment.status === 'PAUSED';
  const isTerminal =
    investment.status === 'MATURED' || investment.status === 'CLOSED' || investment.status === 'CANCELLED';
  const openPositions = investment.positions.filter((position) => position.status === 'OPEN');
  const yieldPct = investment.yieldPct;
  const pnlUsd = investment.realizedPnL + investment.unrealizedPnL;

  const act = async (action: Exclude<PendingAction, null>) => {
    setPending(action);
    setError(null);
    try {
      const response = await apiFetch(`/api/v1/account/investments/${investment.id}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(body, `The ${action} request could not be completed.`));
        setConfirmClose(false);
        return;
      }
      toast({
        variant: 'success',
        title:
          action === 'pause'
            ? 'Strategy paused'
            : action === 'resume'
              ? 'Strategy resumed'
              : 'Investment closed',
        description:
          action === 'pause'
            ? 'No new positions will be opened. Open positions keep being managed.'
            : action === 'resume'
              ? 'The engine will open new positions again.'
              : 'Its capital is back in your withdrawable balance.',
      });
      setConfirmClose(false);
      router.refresh();
    } catch {
      setError('Network error — nothing was changed.');
      setConfirmClose(false);
    } finally {
      setPending(null);
    }
  };

  const columns: DataTableColumn<InvestmentPositionDTO>[] = [
    {
      key: 'symbol',
      header: 'Instrument',
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium text-base-100">{row.symbol}</span>
          <span className="text-[0.68rem] text-muted">{row.strategyId ?? 'strategy'}</span>
        </div>
      ),
    },
    {
      key: 'side',
      header: 'Side',
      cell: (row) => (
        <span className={row.side === 'BUY' ? 'text-profit-600' : 'text-loss-600'}>{row.side}</span>
      ),
    },
    {
      key: 'stake',
      header: 'Stake',
      align: 'right',
      cell: (row) => <Usd value={row.stake} tone="neutral" className="text-xs" />,
    },
    {
      key: 'entry',
      header: 'Entry',
      align: 'right',
      cell: (row) => <span className="font-mono text-xs tabular-nums">{row.entryPrice}</span>,
    },
    {
      key: 'mark',
      header: 'Mark / exit',
      align: 'right',
      cell: (row) => (
        <span className="font-mono text-xs tabular-nums">{row.exitPrice ?? row.currentPrice}</span>
      ),
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
      cell: (row) => <span className="text-xs text-muted">{row.status.toLowerCase()}</span>,
    },
    {
      key: 'opened',
      header: 'Opened',
      cell: (row) => <span className="text-xs text-muted">{formatDate(row.openedAt)}</span>,
    },
  ];

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">{investment.planName}</CardTitle>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusBadge status={investment.status} kind="investment" showIcon />
            <RiskBadge level={investment.riskLevel} />
            <span className={connected ? 'text-profit-600' : 'text-muted'}>
              {connected ? 'live' : 'reconnecting'}
            </span>
            {liveAt ? <span>· updated {relativeTime(new Date(liveAt).toISOString())}</span> : null}
          </p>
        </div>
        <TargetRange min={investment.targetReturnMin} max={investment.targetReturnMax} className="items-end text-right" />
      </CardHeader>

      <CardContent className="flex flex-col gap-5 p-5 pt-2">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Capital deployed"
            value={<Usd value={investment.capitalUsd} tone="neutral" />}
            sub="Allocated to this strategy"
            icon={Wallet}
          />
          <MetricTile
            label="Current value"
            value={<Usd value={investment.currentValUsd} tone="neutral" />}
            sub={`Fees ${investment.feesDeducted.toFixed(2)} USD`}
            icon={Activity}
          />
          <MetricTile
            label="Running P/L"
            value={<SignedUsd value={pnlUsd} />}
            sub={`Realized ${investment.realizedPnL.toFixed(2)} · unrealized ${investment.unrealizedPnL.toFixed(2)}`}
            icon={pnlUsd >= 0 ? TrendingUp : TrendingDown}
          />
          <MetricTile
            label="Yield"
            value={<Pct value={yieldPct} sign />}
            sub={`${openPositions.length} open · ${investment.positions.length} total trades`}
            icon={TrendingUp}
          />
        </div>

        {isTerminal ? (
          <Alert>
            <AlertTitle>This investment has settled</AlertTitle>
            <AlertDescription>
              Capital has been released to your withdrawable balance. The trade log below is the
              final record.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {error ? (
              <Alert variant="warn">
                <AlertTitle>That action did not go through</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {isPaused ? (
                <Button
                  variant="primary"
                  size="sm"
                  className="h-10 sm:h-8"
                  disabled={pending !== null}
                  onClick={() => void act('resume')}
                >
                  <Play aria-hidden />
                  {pending === 'resume' ? 'Resuming…' : 'Resume strategy'}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-10 sm:h-8"
                  disabled={pending !== null}
                  onClick={() => void act('pause')}
                >
                  <Pause aria-hidden />
                  {pending === 'pause' ? 'Pausing…' : 'Pause strategy'}
                </Button>
              )}

              {confirmClose ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-10 sm:h-8"
                    disabled={pending !== null}
                    onClick={() => void act('close')}
                  >
                    {pending === 'close' ? 'Closing…' : 'Confirm close & withdraw'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 sm:h-8"
                    disabled={pending !== null}
                    onClick={() => setConfirmClose(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 sm:h-8"
                  disabled={pending !== null}
                  onClick={() => setConfirmClose(true)}
                >
                  Close &amp; withdraw capital
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">
              Pausing stops new positions immediately; open positions keep being managed to their
              stop or target. Closing is refused until every open position has closed, so capital is
              never released while it is still at risk.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-base-100">Trade log</h3>
            <span className="text-xs text-muted">Newest first</span>
          </div>
          <DataTable
            columns={columns}
            rows={investment.positions}
            getRowKey={(row) => row.id}
            emptyState={
              <EmptyState
                size="sm"
                title="No trades yet"
                description="The engine opens a position when the strategy's rule fires. Entries appear here the moment they are booked, with their live P/L."
              />
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default StrategyTracker;
