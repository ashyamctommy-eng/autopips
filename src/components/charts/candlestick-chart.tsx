'use client';

import * as React from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { CandlestickChart as CandlestickIcon } from 'lucide-react';
import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * Dark theme for the chart canvas.
 *
 * lightweight-charts takes raw colour strings (no Tailwind classes), so these
 * are the literal values of the design tokens in `tailwind.config.ts`:
 * base-900 `#0B0E14`, base-700 `#1A1F2B`, line rgba(148,163,184,0.14),
 * profit-500 `#10B981`, loss-500 `#F43F5E`, brand-400 `#22D3EE`.
 */
const THEME = {
  background: '#0B0E14',
  border: 'rgba(148,163,184,0.14)',
  grid: 'rgba(148,163,184,0.06)',
  text: 'rgba(148,163,184,0.65)',
  crosshair: 'rgba(148,163,184,0.35)',
  upColor: '#10B981',
  downColor: '#F43F5E',
  wickUp: 'rgba(16,185,129,0.75)',
  wickDown: 'rgba(244,63,94,0.75)',
  accent: '#22D3EE',
} as const;

export interface CandlestickChartProps {
  /**
   * Historical candles from the broker adapter
   * (`BrokerAdapter.getHistoricalCandles`). Never synthesised by the UI.
   */
  candles: Candle[];
  /** Plot height in pixels. Defaults to 360. */
  height?: number;
  symbol?: string;
  timeframe?: string;
  className?: string;
  /** Shows a spinner overlay while a fetch is in flight. */
  isLoading?: boolean;
  /** Override the "no data" copy. */
  emptyMessage?: React.ReactNode;
}

/**
 * Candlestick chart (lightweight-charts v4 API).
 *
 * The chart instance is created once in an effect, sized by a ResizeObserver,
 * re-seeded whenever `candles` changes, and disposed on unmount. An empty
 * `candles` array renders an explicit empty state — the component refuses to
 * draw placeholder bars.
 */
export function CandlestickChart({
  candles,
  height = 360,
  symbol,
  timeframe,
  className,
  isLoading = false,
  emptyMessage = 'No verified broker data for this instrument yet.',
}: CandlestickChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<'Candlestick'> | null>(null);

  /* Create + dispose the chart exactly once. */
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: THEME.background },
        textColor: THEME.text,
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        // Left ON deliberately: the lightweight-charts licence requires an
        // attribution link to tradingview.com, and this logo satisfies it.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: THEME.grid, style: LineStyle.Solid },
        horzLines: { color: THEME.grid, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: THEME.border, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: { borderColor: THEME.border, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: THEME.crosshair, width: 1, style: LineStyle.Dashed },
        horzLine: { color: THEME.crosshair, width: 1, style: LineStyle.Dashed },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    const series = chart.addCandlestickSeries({
      upColor: THEME.upColor,
      downColor: THEME.downColor,
      borderUpColor: THEME.upColor,
      borderDownColor: THEME.downColor,
      wickUpColor: THEME.wickUp,
      wickDownColor: THEME.wickDown,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      if (width > 0) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // `height` is applied in its own effect below, so re-creating the chart is
    // not required when only the size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Keep the plot height in sync with the prop. */
  React.useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  /* Re-seed data whenever the candle array changes. */
  React.useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const data: CandlestickData<UTCTimestamp>[] = candles
      .filter(
        (candle) =>
          Number.isFinite(candle.time) &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close),
      )
      .map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));

    series.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const hasData = candles.length > 0;

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border border-line bg-base-900', className)}>
      {(symbol || timeframe) && (
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          {symbol ? <span className="text-sm font-semibold text-base-100">{symbol}</span> : null}
          {timeframe ? (
            <span className="rounded border border-line bg-base-800 px-1.5 py-0.5 font-mono text-[0.68rem] uppercase text-muted">
              {timeframe}
            </span>
          ) : null}
          <span className="ml-auto text-[0.68rem] text-muted">Broker feed</span>
        </div>
      )}
      <div className="relative" style={{ height }}>
        <div
          ref={containerRef}
          aria-label={symbol ? `${symbol} price chart` : 'price chart'}
          className={cn('h-full w-full', !hasData && 'invisible')}
        />
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-base-900/60">
            <Spinner size="lg" tone="brand" label="Loading candles" />
          </div>
        ) : null}
        {!hasData && !isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <EmptyState
              size="sm"
              icon={CandlestickIcon}
              title="No chart data"
              description={emptyMessage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
