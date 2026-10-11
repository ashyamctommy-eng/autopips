'use client';

import * as React from 'react';
import {
  Check,
  ChevronDown,
  Crosshair,
  LineChart,
  Minus,
  MousePointer2,
  Ruler,
  Search,
  TrendingUp,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { IndicatorId } from '@/lib/indicators';

/**
 * CHART TOOLBAR.
 *
 * The control bar above the price chart: instrument, timeframe, indicators,
 * drawing tools, and the two instant-execution buttons.
 *
 * HONESTY ABOUT WHAT IS FUNCTIONAL
 *   - Instrument, timeframe and the indicator toggles are wired: they change what
 *     the chart draws.
 *   - The drawing tools select a MODE. Cursor and Crosshair change the chart's
 *     crosshair behaviour; the three line tools (horizontal, trend, Fibonacci) are
 *     selection-only today — nothing is drawn on the canvas yet, and the menu says
 *     so rather than pretending. Wiring them needs pointer capture and an overlay
 *     layer, which is its own piece of work.
 *   - SELL / BUY hand a side to the order ticket; they do not fire an order by
 *     themselves, so a single click can never move money.
 */

export type DrawingToolId = 'cursor' | 'crosshair' | 'hline' | 'trend' | 'fib';

/**
 * Timeframes. Only the seven the feed can actually serve are selectable; W1 and
 * MN1 are shown DISABLED with the reason, because the candles route (and Deriv's
 * granularity) stop at 1d — offering them enabled would be a button that always
 * fails.
 */
export const TIMEFRAME_OPTIONS = [
  { id: '1m', label: 'M1' },
  { id: '5m', label: 'M5' },
  { id: '15m', label: 'M15' },
  { id: '30m', label: 'M30' },
  { id: '1h', label: 'H1' },
  { id: '4h', label: 'H4' },
  { id: '1d', label: 'D1' },
  { id: '1w', label: 'W1', unavailable: true },
  { id: '1M', label: 'MN1', unavailable: true },
] as const;

const INDICATOR_OPTIONS: readonly { id: IndicatorId; label: string }[] = [
  { id: 'ma', label: 'Moving Average (20, 50)' },
  { id: 'rsi', label: 'RSI (14)' },
  { id: 'macd', label: 'MACD (12, 26, 9)' },
  { id: 'bb', label: 'Bollinger Bands (20, 2)' },
];

const DRAWING_TOOLS = [
  { id: 'cursor', label: 'Cursor', Icon: MousePointer2, functional: true },
  { id: 'crosshair', label: 'Crosshair', Icon: Crosshair, functional: true },
  { id: 'hline', label: 'Horizontal line', Icon: Minus, functional: false },
  { id: 'trend', label: 'Trend line', Icon: TrendingUp, functional: false },
  { id: 'fib', label: 'Fibonacci retracement', Icon: Ruler, functional: false },
] as const;

/** Button + panel with outside-click and Escape dismissal. */
function Menu({
  label,
  icon,
  children,
  align = 'left',
  testId,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: 'left' | 'right';
  testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid={testId}
        className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-base-900/70 px-2.5 text-xs font-medium text-base-100 transition-colors hover:border-brand/60 hover:text-brand-300"
      >
        {icon}
        <span className="max-w-[9rem] truncate">{label}</span>
        <ChevronDown aria-hidden className={cn('size-3.5 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          className={cn(
            'absolute z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line bg-base-900/98 p-2 shadow-[0_18px_48px_-18px_rgba(0,0,0,0.75)] backdrop-blur',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export interface ChartToolbarProps {
  instruments: readonly string[];
  symbol: string | null;
  onSymbolChange: (symbol: string) => void;
  timeframe: string;
  onTimeframeChange: (timeframe: string) => void;
  indicators: readonly IndicatorId[];
  onToggleIndicator: (indicator: IndicatorId) => void;
  drawingTool: DrawingToolId;
  onDrawingToolChange: (tool: DrawingToolId) => void;
  /** Hands a side to the order ticket. Does NOT place an order. */
  onOrderSide: (side: 'BUY' | 'SELL') => void;
  disabled?: boolean;
}

export function ChartToolbar({
  instruments,
  symbol,
  onSymbolChange,
  timeframe,
  onTimeframeChange,
  indicators,
  onToggleIndicator,
  drawingTool,
  onDrawingToolChange,
  onOrderSide,
  disabled = false,
}: ChartToolbarProps) {
  const [query, setQuery] = React.useState('');

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? instruments.filter((item) => item.toLowerCase().includes(needle)) : instruments;
  }, [instruments, query]);

  const timeframeLabel =
    TIMEFRAME_OPTIONS.find((option) => option.id === timeframe)?.label ?? timeframe;
  const drawingLabel =
    DRAWING_TOOLS.find((tool) => tool.id === drawingTool)?.label ?? 'Cursor';

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-base-850/70 p-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {/* Symbol picker with a search drawer. */}
        <Menu
          testId="toolbar-symbol"
          icon={<Search aria-hidden className="size-3.5 text-muted" />}
          label={symbol ?? 'Select instrument'}
        >
          {() => (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search instrument"
                className="h-9 w-full rounded-md border border-line bg-base-950 px-2.5 text-xs text-base-100 outline-none placeholder:text-muted focus:border-brand/60"
                data-testid="toolbar-symbol-search"
              />
              <ul className="max-h-64 overflow-y-auto">
                {matches.length === 0 ? (
                  <li className="px-2 py-3 text-center text-xs text-muted">No instrument matches.</li>
                ) : (
                  matches.map((item) => (
                    <li key={item}>
                      <button
                        type="button"
                        onClick={() => {
                          onSymbolChange(item);
                          setQuery('');
                        }}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-base-800',
                          item === symbol ? 'text-brand-300' : 'text-base-100',
                        )}
                      >
                        <span className="truncate">{item}</span>
                        {item === symbol ? <Check aria-hidden className="size-3.5" /> : null}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </Menu>

        {/* Timeframe. */}
        <Menu testId="toolbar-timeframe" label={timeframeLabel}>
          {(close) => (
            <ul className="grid grid-cols-3 gap-1">
              {TIMEFRAME_OPTIONS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    disabled={'unavailable' in option && option.unavailable}
                    title={
                      'unavailable' in option && option.unavailable
                        ? 'Not served by the market feed (history stops at D1)'
                        : undefined
                    }
                    onClick={() => {
                      onTimeframeChange(option.id);
                      close();
                    }}
                    className={cn(
                      'w-full rounded px-2 py-1.5 text-xs font-medium transition-colors',
                      option.id === timeframe ? 'bg-brand/15 text-brand-300' : 'text-base-100 hover:bg-base-800',
                      'unavailable' in option && option.unavailable && 'cursor-not-allowed text-muted opacity-50 hover:bg-transparent',
                    )}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Menu>

        {/* Indicators. */}
        <Menu
          testId="toolbar-indicators"
          icon={<LineChart aria-hidden className="size-3.5 text-muted" />}
          label={indicators.length > 0 ? `Indicators (${indicators.length})` : 'Indicators'}
        >
          {() => (
            <ul>
              {INDICATOR_OPTIONS.map((option) => {
                const on = indicators.includes(option.id);
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => onToggleIndicator(option.id)}
                      aria-pressed={on}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-base-100 transition-colors hover:bg-base-800"
                    >
                      <span>{option.label}</span>
                      <span
                        className={cn(
                          'grid size-4 place-items-center rounded border text-[0.6rem]',
                          on ? 'border-brand-400 bg-brand/20 text-brand-300' : 'border-line text-transparent',
                        )}
                      >
                        {on ? <Check aria-hidden className="size-3" /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Menu>

        {/* Drawing tools. */}
        <Menu testId="toolbar-drawing" label={drawingLabel}>
          {(close) => (
            <div className="flex flex-col gap-1">
              {DRAWING_TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => {
                    onDrawingToolChange(tool.id);
                    close();
                  }}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-base-800',
                    tool.id === drawingTool ? 'text-brand-300' : 'text-base-100',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <tool.Icon aria-hidden className="size-3.5" />
                    {tool.label}
                  </span>
                  {tool.functional ? null : (
                    <span className="text-[0.6rem] text-muted">not drawn yet</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Menu>
      </div>

      {/* Instant execution: hands a side to the ticket. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
        <button
          type="button"
          onClick={() => onOrderSide('SELL')}
          disabled={disabled}
          data-testid="toolbar-sell"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-loss px-4 text-sm font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Sell
        </button>
        <button
          type="button"
          onClick={() => onOrderSide('BUY')}
          disabled={disabled}
          data-testid="toolbar-buy"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-profit px-4 text-sm font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Buy
        </button>
      </div>
    </div>
  );
}

export default ChartToolbar;
