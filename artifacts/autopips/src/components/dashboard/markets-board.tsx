'use client';

import * as React from 'react';
import Link from '@/lib/next/link';
import { Search, Star } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import { MAX_MARKET_ROOMS_PER_SOCKET } from '@/lib/contracts';
import {
  MARKET_CATEGORIES,
  assetGlyph,
  describeInstrument,
  flagFor,
  type MarketCategoryId,
  type MarketIcon,
  type MarketVisual,
} from '@/lib/market-meta';
import { cn } from '@/lib/utils';
import type { InstrumentInfo } from '@/types/broker.types';
import type { PriceTick } from '@/lib/socket-client';

/**
 * Markets & quotes board.
 *
 * A quotes TABLE (Instrument · Bid/Ask · Spread) laid out the way a desktop
 * terminal lays one out: category tabs across the top, one row per instrument
 * with an icon, a bold ticker and a muted description.
 *
 * TWO RULES THE TABLE HONOURS
 *   1. A price is never invented. No tick yet → an em dash, not a zero, not the
 *      previous close.
 *   2. A closed market says so by SHAPE, not by a badge: the row fades and its
 *      bid/ask/spread become dashes. There is no "tradable / not tradable /
 *      awaiting tick" label anywhere — the requirement, and quieter besides.
 *
 * ONE SOCKET FOR THE WHOLE PAGE. The server caps market rooms per connection at
 * `MAX_MARKET_ROOMS_PER_SOCKET`, so the board subscribes only to the rows it is
 * actually showing (up to that cap). Ticks are broadcast namespace-wide, so rows
 * outside the cap still update if some other client is watching them.
 */

const FAVORITES_KEY = 'bbcap.market.favorites';

interface Row {
  instrument: InstrumentInfo;
  visual: MarketVisual;
}

/** Decimal places to show a price at, derived from the instrument's own pip size. */
function decimalsFor(instrument: InstrumentInfo, visual: MarketVisual): number {
  const pip = instrument.pipSize;
  let decimals = 2;
  if (Number.isFinite(pip) && pip > 0) {
    const text = pip.toString();
    const dot = text.indexOf('.');
    decimals = dot === -1 ? Math.max(2, text.length - 1) : text.length - dot - 1;
  }
  // FX and metals conventionally quote one digit finer than the pip.
  if (visual.category === 'forex' || visual.category === 'metals') decimals += 1;
  return Math.min(8, Math.max(2, decimals));
}

function formatPrice(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** One icon: dual circular flags, an asset glyph, or a market mark. */
function MarketIconView({ icon }: { icon: MarketIcon }) {
  if (icon.kind === 'flags') {
    return (
      <span className="flex shrink-0 items-center" aria-hidden>
        <span className="z-10 grid size-7 place-items-center rounded-full border border-line bg-base-800 text-[0.9rem] leading-none">
          {flagFor(icon.base) ?? icon.base.slice(0, 1)}
        </span>
        <span className="-ml-2 grid size-7 place-items-center rounded-full border border-line bg-base-800 text-[0.9rem] leading-none">
          {flagFor(icon.quote) ?? icon.quote.slice(0, 1)}
        </span>
      </span>
    );
  }
  if (icon.kind === 'asset') {
    const glyph = assetGlyph(icon.asset);
    return (
      <span
        aria-hidden
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold leading-none',
          glyph.className,
        )}
      >
        {glyph.glyph}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-full bg-base-700/40 text-[0.6rem] font-semibold text-muted"
    >
      {icon.label}
    </span>
  );
}

function QuoteCell({ tick, decimals }: { tick: PriceTick | undefined; decimals: number }) {
  const bid = typeof tick?.bid === 'number' ? tick.bid : null;
  const ask = typeof tick?.ask === 'number' ? tick.ask : null;
  const single = typeof tick?.quote === 'number' ? tick.quote : null;

  // A single-price instrument reports one number; show it under Bid and leave Ask
  // as a dash rather than duplicating it.
  if (bid === null && ask === null && single !== null) {
    return <span className="font-mono tabular-nums text-base-100">{formatPrice(single, decimals)}</span>;
  }
  if (bid === null && ask === null) {
    return <span className="font-mono tabular-nums text-muted">–</span>;
  }
  return (
    <span className="font-mono tabular-nums text-base-100">
      {bid === null ? '–' : formatPrice(bid, decimals)}
      <span className="px-1 text-muted">/</span>
      {ask === null ? '–' : formatPrice(ask, decimals)}
    </span>
  );
}

function SpreadCell({ tick, decimals }: { tick: PriceTick | undefined; decimals: number }) {
  const bid = typeof tick?.bid === 'number' ? tick.bid : null;
  const ask = typeof tick?.ask === 'number' ? tick.ask : null;
  if (bid === null || ask === null) return <span className="font-mono tabular-nums text-muted">–</span>;
  const spread = Math.abs(ask - bid);
  return (
    <span className="font-mono tabular-nums text-muted">
      {formatPrice(spread, Math.min(8, decimals + 1))}
    </span>
  );
}

export interface MarketsBoardProps {
  instruments: InstrumentInfo[];
}

export function MarketsBoard({ instruments }: MarketsBoardProps) {
  const [active, setActive] = React.useState<MarketCategoryId>('favorites');
  const [query, setQuery] = React.useState('');
  const [favorites, setFavorites] = React.useState<string[]>([]);

  React.useEffect(() => {
    let loaded: string[] = [];
    try {
      const raw = window.localStorage.getItem(FAVORITES_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) loaded = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // A corrupt/blocked store must not break the board; favourites simply start empty.
    }
    setFavorites(loaded);
    // Terminal boards open on Favorites; with none saved that is an empty screen,
    // so open on the first market with instruments instead.
    if (loaded.length === 0) setActive('forex');
  }, []);

  const toggleFavorite = React.useCallback((symbol: string) => {
    setFavorites((prev) => {
      const next = prev.includes(symbol)
        ? prev.filter((entry) => entry !== symbol)
        : [...prev, symbol];
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // Persisting is best-effort.
      }
      return next;
    });
  }, []);

  const rows = React.useMemo<Row[]>(
    () => instruments.map((instrument) => ({ instrument, visual: describeInstrument(instrument) })),
    [instruments],
  );

  const byCategory = React.useMemo(() => {
    const map = new Map<MarketCategoryId, Row[]>();
    for (const category of MARKET_CATEGORIES) map.set(category.id, []);
    for (const row of rows) map.get(row.visual.category)?.push(row);
    for (const list of map.values()) list.sort((a, b) => a.visual.ticker.localeCompare(b.visual.ticker));
    return map;
  }, [rows]);

  const favoriteSet = React.useMemo(() => new Set(favorites), [favorites]);

  const activeRows = React.useMemo(() => {
    const base =
      active === 'favorites'
        ? rows.filter((row) => favoriteSet.has(row.instrument.symbol))
        : (byCategory.get(active) ?? []);
    const needle = query.trim().toLowerCase();
    return needle ? base.filter((row) => row.visual.search.includes(needle)) : base;
  }, [active, byCategory, favoriteSet, query, rows]);

  // Only the rows on screen are requested upstream, up to the per-socket cap.
  const streamSymbols = React.useMemo(
    () => activeRows.slice(0, MAX_MARKET_ROOMS_PER_SOCKET).map((row) => row.instrument.symbol),
    [activeRows],
  );
  const { ticks, connected } = useTradingSocket({
    marketSymbols: streamSymbols,
    enabled: streamSymbols.length > 0,
  });

  const counts = React.useMemo(() => {
    const map = new Map<MarketCategoryId, number>();
    for (const category of MARKET_CATEGORIES) {
      map.set(
        category.id,
        category.id === 'favorites' ? favorites.length : (byCategory.get(category.id) ?? []).length,
      );
    }
    return map;
  }, [byCategory, favorites.length]);

  const capped = activeRows.length > streamSymbols.length;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-4 border-b border-line/70 p-0 pb-0">
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Market categories" className="-mx-1 flex flex-1 overflow-x-auto">
              <ul className="flex items-stretch gap-1 px-1" role="tablist">
                {MARKET_CATEGORIES.map((category) => {
                  const isActive = category.id === active;
                  const count = counts.get(category.id) ?? 0;
                  return (
                    <li key={category.id} role="presentation">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActive(category.id)}
                        data-testid={`tab-${category.id}`}
                        className={cn(
                          'flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-[0.7rem] font-semibold uppercase tracking-[0.08em] transition-colors',
                          isActive
                            ? 'border-brand-400 text-base-100'
                            : 'border-transparent text-muted hover:text-base-100',
                        )}
                      >
                        {category.label}
                        <span className={cn('text-[0.65rem] font-normal', isActive ? 'text-brand-300' : 'text-muted')}>
                          {count}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 text-[0.68rem]',
                connected ? 'text-profit-600' : 'text-muted',
              )}
              title={connected ? 'Live quote stream connected' : 'Reconnecting to the quote stream'}
            >
              <span className={cn('size-1.5 rounded-full', connected ? 'bg-profit-600' : 'bg-muted')} aria-hidden />
              {connected ? 'live' : 'offline'}
            </span>
          </div>

          <label className="relative block">
            <span className="sr-only">Search instruments</span>
            <Search aria-hidden className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search instrument"
              className="h-9 pl-8"
              data-testid="input-market-search"
            />
          </label>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {activeRows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              size="sm"
              title={
                active === 'favorites'
                  ? 'No favourites yet'
                  : query
                    ? 'No instruments match'
                    : 'No instruments in this market'
              }
              description={
                active === 'favorites'
                  ? 'Star an instrument to pin it here — favourites survive a reload and are the first rows streamed.'
                  : query
                    ? 'Try a different ticker or currency.'
                    : 'The market feed lists no instruments for this category right now.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-left">
              <thead>
                <tr className="bg-base-900/55 text-[0.62rem] font-semibold uppercase tracking-[0.13em] text-muted">
                  <th scope="col" className="px-4 py-2.5">
                    Instrument
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Bid/Ask
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Spread
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeRows.map((row) => {
                  const { instrument, visual } = row;
                  const tick = ticks[instrument.symbol];
                  const decimals = decimalsFor(instrument, visual);
                  const closed = instrument.exchangeIsOpen === false;
                  const isFavorite = favoriteSet.has(instrument.symbol);
                  return (
                    <tr
                      key={instrument.symbol}
                      data-testid={`market-row-${instrument.symbol}`}
                      data-closed={closed ? 'true' : 'false'}
                      data-has-tick={tick ? 'true' : 'false'}
                      // Closed markets fade out entirely — icon, ticker and subtitle
                      // alike — and their quote cells read as dashes.
                      className={cn(
                        'border-b border-line/50 transition-colors last:border-0 hover:bg-base-800/40',
                        closed && 'opacity-[0.45]',
                      )}
                    >
                      <td className="max-w-0 px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => toggleFavorite(instrument.symbol)}
                            aria-label={
                              isFavorite
                                ? `Remove ${visual.ticker} from favourites`
                                : `Add ${visual.ticker} to favourites`
                            }
                            aria-pressed={isFavorite}
                            className="shrink-0 text-muted transition-colors hover:text-brand-300"
                          >
                            <Star
                              aria-hidden
                              className={cn('size-3.5', isFavorite && 'fill-brand-400 text-brand-400')}
                            />
                          </button>
                          <MarketIconView icon={visual.icon} />
                          <div className="flex min-w-0 flex-col">
                            <Link
                              href={`/dashboard/trading?symbol=${encodeURIComponent(instrument.symbol)}`}
                              className="truncate text-sm font-bold uppercase tracking-tight text-base-100 hover:text-brand-300"
                            >
                              {visual.ticker}
                            </Link>
                            <span className="truncate text-[0.7rem] text-muted">{visual.subtitle}</span>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm">
                        {closed ? (
                          <span className="font-mono tabular-nums text-muted">–</span>
                        ) : (
                          <QuoteCell tick={tick} decimals={decimals} />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm">
                        {closed ? (
                          <span className="font-mono tabular-nums text-muted">–</span>
                        ) : (
                          <SpreadCell tick={tick} decimals={decimals} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {capped ? (
          <p className="border-t border-line/50 px-4 py-3 text-[0.68rem] leading-relaxed text-muted">
            Streaming the first {streamSymbols.length} instruments of {activeRows.length} on this
            connection (the per-connection limit is {MAX_MARKET_ROOMS_PER_SOCKET}). Narrow the search
            to stream a different slice.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default MarketsBoard;
