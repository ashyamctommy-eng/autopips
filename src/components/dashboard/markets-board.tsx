'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, Plus, Search, SearchX, X } from 'lucide-react';

import { LiveDot, type LiveDotState } from '@/components/shared/live-dot';
import { MONEY_PLACEHOLDER } from '@/components/shared/money';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useTradingSocket, type TradingSocketStatus } from '@/hooks/use-trading-socket';
import { MAX_MARKET_ROOMS_PER_SOCKET } from '@/lib/contracts';
import { tickMid, type PriceTick } from '@/lib/socket-client';
import { cn } from '@/lib/utils';
import type { InstrumentInfo } from '@/server/modules/broker/broker.types';

/**
 * Markets board (client component).
 *
 * One socket for the WHOLE page: `useTradingSocket` is called exactly once with
 * a watchlist, because the server caps market rooms per connection at
 * `MAX_MARKET_ROOMS_PER_SOCKET` and a hook (hence a socket) per row would both
 * blow that cap and race the shared connection on unmount. Rows without a live
 * tick show an em dash — never zero, never a guessed quote.
 */

/**
 * How many symbols stream without the client asking.
 *
 * Deliberately below the per-connection ceiling: a default screen should not
 * spend the whole room budget before the user touches anything. The cap itself
 * is `MAX_MARKET_ROOMS_PER_SOCKET` and is enforced on every add.
 */
const DEFAULT_WATCHLIST_SIZE = 6;

/**
 * Liquid instruments used to seed the watchlist when the feed offers them.
 * These are real Deriv symbols (the same set the trading panel falls back to);
 * anything missing from the feed is simply skipped and the defaults are filled
 * from the feed instead.
 */
const PREFERRED_DEFAULT_SYMBOLS: readonly string[] = [
  'frxXAUUSD',
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'R_100',
  'R_10',
];

/** The default watchlist: preferred instruments first, then the feed, capped. */
function defaultWatchlist(instruments: InstrumentInfo[]): string[] {
  const chosen: string[] = [];
  const present = new Set(instruments.map((instrument) => instrument.symbol));

  for (const symbol of PREFERRED_DEFAULT_SYMBOLS) {
    if (chosen.length >= DEFAULT_WATCHLIST_SIZE) break;
    if (present.has(symbol)) chosen.push(symbol);
  }

  if (chosen.length < DEFAULT_WATCHLIST_SIZE) {
    // Tradable instruments first, then symbol order, so a seeded list is useful
    // even when none of the preferred symbols exist on this feed.
    const rest = [...instruments].sort(
      (a, b) =>
        Number(b.isTradable) - Number(a.isTradable) || a.symbol.localeCompare(b.symbol),
    );
    for (const instrument of rest) {
      if (chosen.length >= DEFAULT_WATCHLIST_SIZE) break;
      if (!chosen.includes(instrument.symbol)) chosen.push(instrument.symbol);
    }
  }

  return chosen.slice(0, MAX_MARKET_ROOMS_PER_SOCKET);
}

/** `synthetic_index` -> `Synthetic index`. */
function prettifyLabel(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Decimal places implied by the instrument's smallest increment.
 *
 * `pipSize` is the increment the venue quotes in, so it decides how many digits
 * a price is shown with. An unusable value (0 / absent) falls back to two — a
 * rendering default only; it never changes the number itself.
 */
function decimalsForPipSize(pipSize: number): number {
  if (!Number.isFinite(pipSize) || pipSize <= 0) return 2;
  let decimals = 0;
  let scale = 1;
  while (decimals < 8 && scale > pipSize) {
    scale /= 10;
    decimals += 1;
  }
  return decimals;
}

/** Formatters are cached per digit count; a price renders on every tick. */
const priceFormatters = new Map<number, Intl.NumberFormat>();

function priceText(value: number, decimals: number): string {
  let formatter = priceFormatters.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    priceFormatters.set(decimals, formatter);
  }
  return formatter.format(value);
}

/**
 * Which reported value the number is. Naming the side keeps the list honest
 * about a one-sided quote, where the mid is simply the side that arrived.
 */
type QuoteSide = 'mid' | 'bid' | 'ask' | 'price';

const QUOTE_LABEL: Record<QuoteSide, string> = {
  mid: 'mid',
  bid: 'bid',
  ask: 'ask',
  price: 'price',
};

interface QuoteDisplay {
  /** The number to render, or the em dash when nothing has been reported. */
  text: string;
  /** The side the number came from, or null when there is no quote yet. */
  side: QuoteSide | null;
}

function describeTick(tick: PriceTick | undefined, decimals: number): QuoteDisplay {
  if (!tick) return { text: MONEY_PLACEHOLDER, side: null };
  const mid = tickMid(tick);
  if (mid === null || !Number.isFinite(mid)) return { text: MONEY_PLACEHOLDER, side: null };

  const hasBid = typeof tick.bid === 'number' && Number.isFinite(tick.bid);
  const hasAsk = typeof tick.ask === 'number' && Number.isFinite(tick.ask);
  const side: QuoteSide =
    hasBid && hasAsk ? 'mid' : hasBid ? 'bid' : hasAsk ? 'ask' : 'price';

  return { text: priceText(mid, decimals), side };
}

const STATUS_STATE: Record<TradingSocketStatus, LiveDotState> = {
  idle: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  error: 'error',
};

const STATUS_LABEL: Record<TradingSocketStatus, string> = {
  idle: 'Connecting',
  connecting: 'Connecting',
  connected: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Market Feed error',
};

interface MarketRowProps {
  instrument: InstrumentInfo;
  tick: PriceTick | undefined;
  watched: boolean;
  atCap: boolean;
  onToggle: (symbol: string) => void;
}

/**
 * One instrument row. Memoised so a tick on one symbol re-renders only that
 * row, not the whole feed list.
 */
const MarketRow = React.memo(function MarketRow({
  instrument,
  tick,
  watched,
  atCap,
  onToggle,
}: MarketRowProps) {
  const quote = describeTick(tick, decimalsForPipSize(instrument.pipSize));
  const detail = quote.side
    ? QUOTE_LABEL[quote.side]
    : watched
      ? 'awaiting tick'
      : 'not streaming';

  return (
    <li className="border-b border-line/60 last:border-b-0">
      <div className="flex items-stretch gap-1">
        <Link
          href={`/dashboard/trading?symbol=${encodeURIComponent(instrument.symbol)}`}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 transition-colors hover:bg-base-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40 sm:px-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-mono text-sm font-medium text-base-100">
                {instrument.symbol}
              </span>
              {instrument.isTradable ? null : <Badge variant="warn">Not tradable</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">{instrument.displayName}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[0.68rem] uppercase tracking-wide text-muted">
              <span>{prettifyLabel(instrument.market)}</span>
              {instrument.submarket ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate normal-case">{prettifyLabel(instrument.submarket)}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="tabular-nums text-sm font-medium text-base-100">{quote.text}</span>
            <span className="text-[0.65rem] uppercase tracking-wide text-muted">{detail}</span>
          </div>
        </Link>

        <div className="flex items-center pr-2 sm:pr-3">
          <button
            type="button"
            onClick={() => onToggle(instrument.symbol)}
            disabled={!watched && atCap}
            aria-pressed={watched}
            aria-label={
              watched
                ? `Remove ${instrument.symbol} from the watchlist`
                : `Add ${instrument.symbol} to the watchlist`
            }
            title={
              !watched && atCap
                ? `The watchlist is full at ${MAX_MARKET_ROOMS_PER_SOCKET} symbols`
                : undefined
            }
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-md border border-line bg-base-800/60 text-muted transition-colors',
              'hover:border-brand/40 hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {watched ? (
              <Check aria-hidden className="size-4 text-brand-300" />
            ) : (
              <Plus aria-hidden className="size-4" />
            )}
          </button>
        </div>
      </div>
    </li>
  );
});

export interface MarketsBoardProps {
  /** Instruments reported by the broker's public feed, in feed order. */
  instruments: InstrumentInfo[];
}

export function MarketsBoard({ instruments }: MarketsBoardProps) {
  const [watchlist, setWatchlist] = React.useState<string[]>(() =>
    defaultWatchlist(instruments),
  );
  const [query, setQuery] = React.useState('');

  // ONE hook (and one socket) for the page: the watchlist is the only thing that
  // varies. An empty watchlist keeps the hook mounted but offline.
  const { status, connected, error, ticks } = useTradingSocket({
    marketSymbols: watchlist,
    enabled: watchlist.length > 0,
  });

  const toggleSymbol = React.useCallback((symbol: string) => {
    setWatchlist((prev) => {
      if (prev.includes(symbol)) return prev.filter((entry) => entry !== symbol);
      // The cap is enforced before the room is requested, matching the server's
      // per-connection limit; extras are refused here rather than by an error.
      if (prev.length >= MAX_MARKET_ROOMS_PER_SOCKET) return prev;
      return [...prev, symbol];
    });
  }, []);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return instruments;
    return instruments.filter(
      (instrument) =>
        instrument.symbol.toLowerCase().includes(needle) ||
        instrument.displayName.toLowerCase().includes(needle) ||
        instrument.market.toLowerCase().includes(needle) ||
        instrument.submarket.toLowerCase().includes(needle),
    );
  }, [instruments, query]);

  const watchedSymbols = React.useMemo(() => new Set(watchlist), [watchlist]);
  const atCap = watchlist.length >= MAX_MARKET_ROOMS_PER_SOCKET;
  const streaming = watchlist.length > 0;

  const liveState: LiveDotState = streaming ? STATUS_STATE[status] : 'paused';
  const liveLabel = !streaming
    ? 'No symbols streaming'
    : connected
      ? `Live · ${watchlist.length} streaming`
      : STATUS_LABEL[status];

  if (instruments.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-base-850/60">
        <EmptyState
          icon={SearchX}
          title="The Market Feed listed no instruments"
          description="The Market Feed answered but reported no instruments, so there is nothing to list. The page stays empty until the feed reports them."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-2 p-4 pb-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <CardTitle>Live watchlist</CardTitle>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {streaming
                ? `Streaming ${watchlist.length} of ${MAX_MARKET_ROOMS_PER_SOCKET} possible symbols on this connection.`
                : `Add instruments from the list below to stream their quotes. One connection carries up to ${MAX_MARKET_ROOMS_PER_SOCKET} symbols.`}
            </p>
          </div>
          <LiveDot state={liveState} label={liveLabel} className="shrink-0" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          {streaming ? (
            <div className="flex flex-wrap gap-2">
              {watchlist.map((symbol) => (
                <span
                  key={symbol}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-base-800/70 py-1 pl-3 pr-1"
                >
                  <span className="font-mono text-xs text-base-100">{symbol}</span>
                  <button
                    type="button"
                    onClick={() => toggleSymbol(symbol)}
                    aria-label={`Remove ${symbol} from the watchlist`}
                    className="inline-flex size-5 items-center justify-center rounded-full text-muted transition-colors hover:bg-base-700 hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <EmptyState
              size="sm"
              title="No symbols streaming"
              description="Use the add control on any row below to start streaming its quotes."
            />
          )}

          {atCap ? (
            <p className="text-xs leading-relaxed text-warn-400">
              Watchlist full: {MAX_MARKET_ROOMS_PER_SOCKET} symbols is the limit for one
              connection. Remove a symbol above before adding another.
            </p>
          ) : null}

          {error ? (
            <p className="text-xs leading-relaxed text-loss-400">Market Feed error: {error}</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-base-850/80 p-4 shadow-card backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full flex-col gap-1 sm:max-w-xs">
          <label htmlFor="market-search" className="sr-only">
            Search instruments
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              id="market-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search symbol, name or market"
              autoComplete="off"
              className="pl-9"
            />
          </div>
        </div>
        <p className="text-xs text-muted">
          {filtered.length} of {instruments.length} instruments
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-base-850/80 shadow-card backdrop-blur-sm">
        {filtered.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No instruments match"
            description={`Nothing in the feed matches “${query.trim()}”. Clear the search to see the full list.`}
            action={
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-xs text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                Clear search
              </button>
            }
          />
        ) : (
          <>
            <p className="border-b border-line px-4 py-3 text-xs leading-relaxed text-muted">
              Live prices are the quote reported by the Market Feed, shown at the precision of each
              instrument in its own units — never converted to USD. An em dash means no quote has
              arrived for that symbol yet.
            </p>
            <ul>
              {filtered.map((instrument) => (
                <MarketRow
                  key={instrument.symbol}
                  instrument={instrument}
                  tick={ticks[instrument.symbol]}
                  watched={watchedSymbols.has(instrument.symbol)}
                  atCap={atCap}
                  onToggle={toggleSymbol}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
