'use client';

import * as React from 'react';
import { useLocation } from 'wouter';
import Link from '@/lib/next/link';
import { Fuel, Gem, Search, Star } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { CryptoIcon, FlagIcon } from '@/components/shared/flag-icon';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import { MAX_MARKET_ROOMS_PER_SOCKET } from '@/lib/contracts';
import {
  MARKET_CATEGORIES,
  assetGlyph,
  describeInstrument,
  type MarketCategoryId,
  type MarketIcon,
  type MarketVisual,
} from '@/lib/market-meta';
import { tickMid, type PriceTick } from '@/lib/socket-client';
import { cn } from '@/lib/utils';
import type { InstrumentInfo } from '@/types/broker.types';

/**
 * Markets & quotes board.
 *
 * A quotes TABLE (Instrument · Bid/Ask · Spread · ★) laid out like a desktop
 * terminal: category tabs across the top, one row per instrument with a logo, a
 * bold ticker and a muted description.
 *
 * RULES THE TABLE HONOURS
 *   1. A price is never invented. No tick yet → an em dash, not a zero.
 *   2. A closed market says so by SHAPE, not a badge: the row fades and its
 *      Bid/Ask/Spread read as dashes. There is no "tradable / awaiting tick" label.
 *   3. Bid and Ask are STACKED (bid green above, ask red beneath) so the two
 *      numbers are never read as one. A brief background flash marks the last
 *      move, so direction is visible without recolouring the numbers.
 *
 * ONE SOCKET FOR THE WHOLE PAGE, subscribing only to the rows on screen (up to the
 * per-connection room cap). Ticks are broadcast namespace-wide, so rows outside
 * the cap still update if another client is watching them.
 */

const FAVORITES_KEY = 'bbcap.market.favorites';
const FLASH_MS = 600;

interface Row {
  instrument: InstrumentInfo;
  visual: MarketVisual;
}

type Flash = 'up' | 'down';

/** Decimal places to show a price at, derived from the instrument's own pip size. */
function decimalsFor(instrument: InstrumentInfo, visual: MarketVisual): number {
  const pip = instrument.pipSize;
  let decimals = 2;
  if (Number.isFinite(pip) && pip > 0) {
    const text = pip.toString();
    const dot = text.indexOf('.');
    decimals = dot === -1 ? Math.max(2, text.length - 1) : text.length - dot - 1;
  }
  if (visual.category === 'forex' || visual.category === 'metals') decimals += 1;
  return Math.min(8, Math.max(2, decimals));
}

function formatPrice(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** One icon: dual circular flags, a crypto logo, a metal glyph, or a market mark. */
function MarketIconView({ icon }: { icon: MarketIcon }) {
  if (icon.kind === 'flags') {
    return (
      <span className="flex shrink-0 items-center" aria-hidden>
        <FlagIcon code={icon.base} size={28} className="relative z-10" />
        <FlagIcon code={icon.quote} size={28} className="-ml-2" />
      </span>
    );
  }

  if (icon.kind === 'asset') {
    const asset = icon.asset;
    if (asset === 'OIL' || asset === 'BRENT') {
      return (
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-amber-700/15 text-amber-500"
        >
          <Fuel className="size-4" />
        </span>
      );
    }
    if (asset === 'XAU' || asset === 'XAG' || asset === 'XPD' || asset === 'XPT') {
      return (
        <span
          aria-hidden
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full',
            assetGlyph(asset).className,
          )}
        >
          <Gem className="size-4" />
        </span>
      );
    }
    // Crypto: the real coin logo, with the lettered disc as the fallback.
    return <CryptoIcon symbol={asset} size={28} />;
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

/**
 * The Bid/Ask cell: BID STACKED ABOVE ASK.
 *
 * Fixed colours (bid green, ask red) rather than a single tinted number: with the
 * two prices on separate lines the colour identifies the SIDE, which a
 * movement-tinted single value could not do. Direction is carried by the brief
 * background flash instead, so the two signals never compete.
 */
function QuoteCell({
  tick,
  decimals,
  flash,
}: {
  tick: PriceTick | undefined;
  decimals: number;
  flash: Flash | null;
}) {
  const bid = typeof tick?.bid === 'number' ? tick.bid : null;
  const ask = typeof tick?.ask === 'number' ? tick.ask : null;
  const single = typeof tick?.quote === 'number' ? tick.quote : null;

  const bidText = bid !== null ? formatPrice(bid, decimals) : single !== null ? formatPrice(single, decimals) : '–';
  const askText = ask !== null ? formatPrice(ask, decimals) : '–';

  return (
    <span
      className={cn(
        'inline-flex flex-col items-end gap-0.5 rounded px-1 py-0.5 font-mono tabular-nums leading-tight transition-colors duration-500',
        flash === 'up' ? 'bg-profit/10' : flash === 'down' ? 'bg-loss/10' : 'bg-transparent',
      )}
    >
      <span className="text-profit-600">{bidText}</span>
      <span className="text-loss-600">{askText}</span>
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
  /**
   * Every row opens the standalone WebTrader for that instrument.
   *
   * The whole row is the target (touch screens have no hover, so a link buried in
   * one cell is a poor tap target), while the ticker keeps a real anchor so the
   * row is still reachable by keyboard and "open in new tab".
   */
  const [, navigate] = useLocation();
  const openWebTrader = React.useCallback(
    (symbol: string) => {
      navigate(`/webtrader?symbol=${encodeURIComponent(symbol)}`);
    },
    [navigate],
  );

  React.useEffect(() => {
    let loaded: string[] = [];
    try {
      const raw = window.localStorage.getItem(FAVORITES_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) loaded = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // A corrupt/blocked store must not break the board; favourites start empty.
    }
    setFavorites(loaded);
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

  const streamSymbols = React.useMemo(
    () => activeRows.slice(0, MAX_MARKET_ROOMS_PER_SOCKET).map((row) => row.instrument.symbol),
    [activeRows],
  );
  const { ticks, connected } = useTradingSocket({
    marketSymbols: streamSymbols,
    enabled: streamSymbols.length > 0,
  });

  /*
   * MOVEMENT FLASH. Each tick is compared with the PREVIOUS tick for that symbol
   * (never the day's open, which the feed does not send) and paints a short-lived
   * background on the price cell. The comparison runs per tick; the repaint is
   * throttled so a busy market cannot re-render the table dozens of times a
   * second, and the flash clears itself after FLASH_MS.
   */
  const lastPriceRef = React.useRef<Map<string, number>>(new Map());
  const pendingRef = React.useRef<Record<string, Flash>>({});
  const [flash, setFlash] = React.useState<Record<string, Flash>>({});
  const clearTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    for (const [symbol, tick] of Object.entries(ticks)) {
      const price = tickMid(tick);
      if (price === null) continue;
      const previous = lastPriceRef.current.get(symbol);
      lastPriceRef.current.set(symbol, price);
      if (previous === undefined || price === previous) continue;
      pendingRef.current[symbol] = price > previous ? 'up' : 'down';
    }
  }, [ticks]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      const pending = pendingRef.current;
      if (Object.keys(pending).length === 0) return;
      pendingRef.current = {};
      setFlash((prev) => ({ ...prev, ...pending }));
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setFlash({}), FLASH_MS);
    }, 400);
    return () => {
      clearInterval(timer);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

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
                  ? 'Tap the star beside an instrument to pin it here — favourites survive a reload and are the first rows streamed.'
                  : query
                    ? 'Try a different ticker or currency.'
                    : 'The market feed lists no instruments for this category right now.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] border-collapse text-left">
              <thead>
                <tr className="bg-base-900/55 text-[0.62rem] font-semibold uppercase tracking-[0.13em] text-muted">
                  <th scope="col" className="px-3 py-2.5 sm:px-4">
                    Instrument
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right sm:px-4">
                    Bid/Ask
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right sm:px-4">
                    Spread
                  </th>
                  <th scope="col" className="w-10 px-2 py-2.5 text-center">
                    <span className="sr-only">Favourite</span>
                    <Star aria-hidden className="mx-auto size-3.5" />
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
                  const rowFlash = closed ? null : (flash[instrument.symbol] ?? null);
                  return (
                    <tr
                      key={instrument.symbol}
                      data-testid={`market-row-${instrument.symbol}`}
                      data-closed={closed ? 'true' : 'false'}
                      data-has-tick={tick ? 'true' : 'false'}
                      onClick={() => openWebTrader(instrument.symbol)}
                      className={cn(
                        'cursor-pointer border-b border-line/50 transition-colors last:border-0 hover:bg-base-800/40',
                        closed && 'opacity-[0.45]',
                      )}
                    >
                      <td className="max-w-0 px-3 py-2.5 sm:px-4">
                        <div className="flex items-center gap-2.5">
                          <MarketIconView icon={visual.icon} />
                          <div className="flex min-w-0 flex-col">
                            <Link
                              href={`/webtrader?symbol=${encodeURIComponent(instrument.symbol)}`}
                              className="truncate text-sm font-bold uppercase tracking-tight text-base-100 hover:text-brand-300"
                            >
                              {visual.ticker}
                            </Link>
                            <span className="truncate text-[0.7rem] text-muted">{visual.subtitle}</span>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-sm sm:px-4">
                        {closed ? (
                          <span className="inline-flex flex-col items-end gap-0.5 font-mono tabular-nums leading-tight text-muted">
                            <span>–</span>
                            <span>–</span>
                          </span>
                        ) : (
                          <QuoteCell tick={tick} decimals={decimals} flash={rowFlash} />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-sm sm:px-4">
                        {closed ? (
                          <span className="font-mono tabular-nums text-muted">–</span>
                        ) : (
                          <SpreadCell tick={tick} decimals={decimals} />
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <button
                          type="button"
                          onClick={(event) => {
                            // Favouriting must not also navigate away from the board.
                            event.stopPropagation();
                            toggleFavorite(instrument.symbol);
                          }}
                          aria-label={
                            isFavorite
                              ? `Remove ${visual.ticker} from favourites`
                              : `Add ${visual.ticker} to favourites`
                          }
                          aria-pressed={isFavorite}
                          className="text-muted transition-colors hover:text-brand-300"
                        >
                          <Star
                            aria-hidden
                            className={cn('size-4', isFavorite && 'fill-brand-400 text-brand-400')}
                          />
                        </button>
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
