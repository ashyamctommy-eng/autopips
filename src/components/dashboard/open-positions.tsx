'use client';

import * as React from 'react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { LiveDot } from '@/components/shared/live-dot';
import { SignedUsd } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, relativeTime } from '@/lib/utils';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import { applyPositionUpdate } from '@/lib/socket-client';
import type { PositionDTO } from '@/types/api';

/**
 * Open positions table (client component).
 *
 * Hydrated once from the server (`listPositions`) and then folded together with
 * the `trade:opened|updated|closed` deltas from `useTradingSocket`. Only values
 * the broker actually reported are applied — `applyPositionUpdate` ignores
 * absent fields, so a partial event can never blank a known value.
 *
 * TWO HONESTY RULES ENFORCED HERE:
 *  1. `currentPrice` is null whenever the broker has not reported a live price.
 *     The cell renders an em dash with an explanation — never the entry price.
 *  2. An OPEN row's floating P/L reads 0 until a broker figure arrives (the
 *     `TradeRecord` P/L columns keep their schema default for open trades), and
 *     0 is indistinguishable from "not reported". So a zero with no live delta
 *     behind it is rendered as unknown, not as a break-even result.
 */

export interface OpenPositionsProps {
  /** Investment room to mirror; null disables the subscription. */
  investmentId: string | null;
  /** Server-hydrated positions (open ones are rendered). */
  initialPositions: PositionDTO[];
  /** Copy for the empty state — e.g. a different page may word it differently. */
  emptyDescription?: string;
}

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

function formatPrice(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return priceFormatter.format(value);
}

const DIRECTION_META: Record<string, { label: string; className: string; variant: 'success' | 'danger' }> = {
  BUY: { label: 'Buy', className: 'text-profit-400', variant: 'success' },
  SELL: { label: 'Sell', className: 'text-loss-400', variant: 'danger' },
};

/** A value the API could not supply, rendered as a dash that explains itself. */
function UnknownValue({ explanation, className }: { explanation: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn('cursor-help tabular-nums text-muted underline decoration-dotted', className)}
        >
          —
        </span>
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}

export function OpenPositions({
  investmentId,
  initialPositions,
  emptyDescription = 'Positions appear here once the strategy engine opens a trade on this account.',
}: OpenPositionsProps) {
  const { positionUpdates, status, connected } = useTradingSocket({
    investmentId,
    enabled: Boolean(investmentId),
  });

  const rows = React.useMemo(
    () =>
      initialPositions
        .filter((position) => position.status === 'OPEN')
        .map((position) => {
          const update = positionUpdates[position.id];
          return update ? applyPositionUpdate(position, update) : position;
        }),
    [initialPositions, positionUpdates],
  );

  /**
   * Position ids for which the realtime channel carried a floating P/L. Only
   * those may render a zero, because only those zeros are broker-observed.
   */
  const reportedFloating = React.useMemo(() => {
    const ids = new Set<string>();
    for (const [id, update] of Object.entries(positionUpdates)) {
      if (typeof update.floatingPnL === 'number' || typeof update.unrealizedPnL === 'number') {
        ids.add(id);
      }
    }
    return ids;
  }, [positionUpdates]);

  const columns = React.useMemo<DataTableColumn<PositionDTO>[]>(
    () => [
      {
        key: 'instrument',
        header: 'Instrument',
        cell: (position) => (
          <span className="font-mono text-xs text-base-100">{position.instrument}</span>
        ),
      },
      {
        key: 'direction',
        header: 'Direction',
        cell: (position) => {
          const meta = DIRECTION_META[position.direction?.toUpperCase() ?? ''];
          if (!meta) {
            return (
              <Badge variant="outline" title="Direction reported by the broker was not recognised">
                {position.direction}
              </Badge>
            );
          }
          return (
            <span className={cn('text-xs font-medium uppercase', meta.className)}>{meta.label}</span>
          );
        },
      },
      {
        key: 'volume',
        header: 'Volume',
        align: 'right',
        cell: (position) => (
          <span className="tabular-nums text-base-100">{priceFormatter.format(position.volume)}</span>
        ),
      },
      {
        key: 'entry',
        header: 'Entry',
        align: 'right',
        cell: (position) => (
          <span className="tabular-nums text-base-100">{formatPrice(position.entryPrice)}</span>
        ),
      },
      {
        key: 'current',
        header: 'Current',
        align: 'right',
        cell: (position) => {
          const current = formatPrice(position.currentPrice);
          if (current === null) {
            return (
              <UnknownValue explanation="The broker has not reported a live price for this position. The entry price is deliberately not shown here, because it is not the current price." />
            );
          }
          return <span className="tabular-nums text-base-100">{current}</span>;
        },
      },
      {
        key: 'stops',
        header: 'SL / TP',
        align: 'right',
        cell: (position) => {
          const stopLoss = formatPrice(position.stopLoss);
          const takeProfit = formatPrice(position.takeProfit);
          return (
            <span className="tabular-nums text-xs text-muted">
              {stopLoss ?? '—'} / {takeProfit ?? '—'}
            </span>
          );
        },
      },
      {
        key: 'floating',
        header: 'Floating P/L',
        align: 'right',
        cell: (position) => {
          const live = reportedFloating.has(position.id);
          const value = position.floatingPnL;
          const unknown = !live && (value === null || value === undefined || value === 0);
          if (unknown) {
            return (
              <UnknownValue explanation="No live P/L has been reported for this position yet. A zero here would read as break-even, and the broker bridge has not measured one." />
            );
          }
          return <SignedUsd value={value} />;
        },
      },
      {
        key: 'opened',
        header: 'Opened',
        align: 'right',
        cell: (position) => (
          <time
            dateTime={position.openedAt}
            suppressHydrationWarning
            className="text-xs tabular-nums text-muted"
          >
            {relativeTime(position.openedAt)}
          </time>
        ),
      },
    ],
    [reportedFloating],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
            Open positions
          </h2>
          <p className="mt-1 text-sm text-muted">
            Live deltas arrive over the realtime channel; the table hydrates from stored rows.
          </p>
        </div>
        <LiveDot state={connected ? 'connected' : 'disconnected'} />
      </div>

      <DataTable<PositionDTO>
        columns={columns}
        rows={rows}
        getRowKey={(position) => position.id}
        isLoading={false}
        emptyState={
          <EmptyState
            size="sm"
            title="No open positions"
            description={emptyDescription}
            footer={status === 'connected' ? undefined : 'Realtime link is not connected.'}
          />
        }
      />
    </div>
  );
}

export default OpenPositions;
