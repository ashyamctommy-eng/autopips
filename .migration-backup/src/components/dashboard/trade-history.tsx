'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { SignedUsd } from '@/components/shared/money';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn, relativeTime } from '@/lib/utils';
// Type-only import: erased at build time, so no server module reaches the
// browser bundle. `TradeDTO` is the wire shape `listTrades` returns and is
// declared next to the service that produces it.
import type { TradeDTO } from '@/server/modules/account/account.service';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Trade history table (client component).
 *
 * The first page and the filter options arrive from the server component
 * (`listTrades`); further pages are fetched from `GET /api/v1/account/trades`
 * with the cursor the API returned. Filters are navigation: changing one pushes
 * a query string, so the server component re-reads the ledger and the table can
 * never drift from what the API actually returned.
 */

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'OPEN', label: 'Open' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const;

export interface TradeHistoryProps {
  initialItems: TradeDTO[];
  initialNextCursor: string | null;
  /** Active filters, as the server understood them. */
  status: string | null;
  instrument: string | null;
  /** Instruments seen in this account's trade records. */
  instruments: string[];
  /**
   * True when the instrument filter is applied within a bounded window of
   * recent trades (the API's trade query filters by status only).
   */
  instrumentWindow: boolean;
}

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return priceFormatter.format(value);
}

function isTradeish(value: unknown): value is TradeDTO {
  if (typeof value !== 'object' || value === null) return false;
  const trade = value as Record<string, unknown>;
  return (
    typeof trade.id === 'string' &&
    typeof trade.instrument === 'string' &&
    typeof trade.direction === 'string' &&
    typeof trade.volume === 'number' &&
    typeof trade.netPnL === 'number' &&
    typeof trade.status === 'string' &&
    typeof trade.openedAt === 'string'
  );
}

/** Narrow a `/api/v1/account/trades` envelope to its page of trades. */
function parsePage(body: unknown): { items: TradeDTO[]; nextCursor: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true) return null;
  const data = envelope.data as { items?: unknown; nextCursor?: unknown } | null | undefined;
  if (!data || !Array.isArray(data.items)) return null;
  return {
    items: data.items.filter(isTradeish),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return null;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : null;
}

export function TradeHistory({
  initialItems,
  initialNextCursor,
  status,
  instrument,
  instruments,
  instrumentWindow,
}: TradeHistoryProps) {
  const router = useRouter();
  const [items, setItems] = React.useState<TradeDTO[]>(initialItems);
  const [nextCursor, setNextCursor] = React.useState<string | null>(initialNextCursor);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isNavigating, startNavigation] = React.useTransition();

  /* A new server page (filter change or `router.refresh()`) resets the window. */
  React.useEffect(() => {
    setItems(initialItems);
    setNextCursor(initialNextCursor);
    setError(null);
  }, [initialItems, initialNextCursor]);

  const applyFilters = React.useCallback(
    (nextStatus: string, nextInstrument: string) => {
      const params = new URLSearchParams();
      if (nextStatus !== 'ALL') params.set('status', nextStatus);
      if (nextInstrument !== 'ALL') params.set('instrument', nextInstrument);
      const query = params.toString();
      startNavigation(() => {
        router.push(query ? `/dashboard/history?${query}` : '/dashboard/history');
      });
    },
    [router],
  );

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({ take: String(PAGE_SIZE), cursor: nextCursor });
      if (status) params.set('status', status);
      const response = await apiFetch(`/api/v1/account/trades?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const body: unknown = await response.json();
      const page = parsePage(body);
      if (!page) {
        setError(errorMessage(body) ?? `Could not load more trades (HTTP ${response.status}).`);
        return;
      }
      setItems((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setError('Could not load more trades. Check your connection and try again.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, nextCursor, status]);

  const columns = React.useMemo<DataTableColumn<TradeDTO>[]>(
    () => [
      {
        key: 'instrument',
        header: 'Instrument',
        cell: (trade) => <span className="font-mono text-xs text-base-100">{trade.instrument}</span>,
      },
      {
        key: 'direction',
        header: 'Direction',
        cell: (trade) => {
          const direction = trade.direction?.toUpperCase() ?? '';
          return (
            <span
              className={cn(
                'text-xs font-medium uppercase',
                direction === 'BUY'
                  ? 'text-profit-400'
                  : direction === 'SELL'
                    ? 'text-loss-400'
                    : 'text-muted',
              )}
            >
              {trade.direction}
            </span>
          );
        },
      },
      {
        key: 'volume',
        header: 'Volume',
        align: 'right',
        cell: (trade) => <span className="tabular-nums">{priceFormatter.format(trade.volume)}</span>,
      },
      {
        key: 'entry',
        header: 'Entry',
        align: 'right',
        cell: (trade) => <span className="tabular-nums">{formatPrice(trade.entryPrice)}</span>,
      },
      {
        key: 'exit',
        header: 'Exit',
        align: 'right',
        cell: (trade) => <span className="tabular-nums">{formatPrice(trade.exitPrice)}</span>,
      },
      {
        key: 'gross',
        header: 'Gross P/L',
        align: 'right',
        cell: (trade) => <SignedUsd value={trade.grossPnL} />,
      },
      {
        key: 'commission',
        header: 'Commission',
        align: 'right',
        cell: (trade) => <SignedUsd value={trade.commission} />,
      },
      {
        key: 'swap',
        header: 'Swap',
        align: 'right',
        cell: (trade) => <SignedUsd value={trade.swap} />,
      },
      {
        key: 'net',
        header: 'Net P/L',
        align: 'right',
        cell: (trade) => (
          <SignedUsd value={trade.netPnL} className={trade.status === 'OPEN' ? 'text-muted' : undefined} />
        ),
      },
      {
        key: 'window',
        header: 'Opened / Closed',
        align: 'right',
        cell: (trade) => (
          <span className="flex flex-col items-end gap-0.5 text-xs text-muted">
            <time dateTime={trade.openedAt} suppressHydrationWarning className="tabular-nums">
              {relativeTime(trade.openedAt)}
            </time>
            <time
              dateTime={trade.closedAt ?? ''}
              suppressHydrationWarning
              className="tabular-nums"
            >
              {trade.closedAt ? relativeTime(trade.closedAt) : 'open'}
            </time>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-44">
          <Label htmlFor="history-status" muted>
            Status
          </Label>
          <Select value={status ?? 'ALL'} onValueChange={(value) => applyFilters(value, instrument ?? 'ALL')}>
            <SelectTrigger id="history-status" className="h-10 sm:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-full flex-col gap-1.5 sm:w-52">
          <Label htmlFor="history-instrument" muted>
            Instrument
          </Label>
          <Select
            value={instrument ?? 'ALL'}
            onValueChange={(value) => applyFilters(status ?? 'ALL', value)}
            disabled={instruments.length === 0}
          >
            <SelectTrigger id="history-instrument" className="h-10 sm:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All instruments</SelectItem>
              {instruments.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 pb-1 text-xs text-muted">
          {isNavigating ? <Spinner size="sm" label="Applying filters" /> : null}
          <span>
            Showing {items.length} {items.length === 1 ? 'trade' : 'trades'}
            {instrumentWindow && instrument
              ? ` on this page matching ${instrument} (within the most recent 200 trades)`
              : ''}
          </span>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-loss-400">
          {error}
        </p>
      ) : null}

      <DataTable<TradeDTO>
        columns={columns}
        rows={items}
        getRowKey={(trade) => trade.id}
        caption={
          instrumentWindow && instrument
            ? 'Instrument filtering is applied to the 200 most recent trades returned by the API.'
            : undefined
        }
        emptyState={
          <EmptyState
            size="sm"
            title="No trades match"
            description="Adjust the filters, or wait for the strategy engine to publish a broker-confirmed fill."
          />
        }
      />

      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-10 sm:h-8"
            onClick={() => void loadMore()}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? <Spinner size="sm" label="Loading" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default TradeHistory;
