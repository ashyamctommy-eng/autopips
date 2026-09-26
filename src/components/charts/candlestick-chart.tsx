'use client';

import * as React from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { cn } from '@/lib/utils';
import {
  MONOSPACE_FALLBACK,
  readMonospaceFamily,
  resolveTokens,
  type TokenSpec,
} from '@/lib/theme';
import { useThemeVersion } from '@/components/theme/use-theme-tokens';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { CandlestickChart as CandlestickIcon } from 'lucide-react';
import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * Chart palette.
 *
 * lightweight-charts paints to a canvas and takes raw colour strings (no
 * Tailwind classes), so these are read at runtime from the design tokens in
 * `globals.css` via `getComputedStyle`. `useThemeTokens` re-reads them whenever
 * `<html data-theme>` changes, and the chart re-applies them with
 * `applyOptions` — the canvas follows a light/dark switch like everything else.
 * The fallbacks are the dark palette and cover the server render.
 */
const CHART_TOKENS = {
  background: { token: '--c-base-900', fallback: 'rgb(11, 14, 20)' },
  border: { token: '--chart-axis', fallback: 'rgba(148, 163, 184, 0.14)' },
  grid: { token: '--chart-grid', fallback: 'rgba(148, 163, 184, 0.06)' },
  text: { token: '--chart-tick', fallback: 'rgba(148, 163, 184, 0.65)' },
  crosshair: { token: '--chart-crosshair', fallback: 'rgba(148, 163, 184, 0.35)' },
  upColor: { token: '--c-profit-500', fallback: 'rgb(16, 185, 129)' },
  downColor: { token: '--c-loss-500', fallback: 'rgb(244, 63, 94)' },
  wickUp: { token: '--c-profit-500', alpha: 0.75, fallback: 'rgba(16, 185, 129, 0.75)' },
  wickDown: { token: '--c-loss-500', alpha: 0.75, fallback: 'rgba(244, 63, 94, 0.75)' },
  volumeUp: { token: '--c-profit-500', alpha: 0.45, fallback: 'rgba(16, 185, 129, 0.45)' },
  volumeDown: { token: '--c-loss-500', alpha: 0.45, fallback: 'rgba(244, 63, 94, 0.45)' },
  accent: { token: '--c-brand-400', alpha: 0.75, fallback: 'rgba(34, 211, 238, 0.75)' },
} satisfies Record<string, TokenSpec>;

type ChartTheme = { [K in keyof typeof CHART_TOKENS]: string } & { fontFamily: string };

/** Resolve the live chart palette. Safe to call during a client render. */
function resolveChartTheme(): ChartTheme {
  return {
    ...resolveTokens(CHART_TOKENS),
    fontFamily: readMonospaceFamily(MONOSPACE_FALLBACK),
  };
}

/**
 * Order-overlay palette (brief: entry solid blue, stop dashed red, target
 * dashed green). Kept next to the chart theme so the overlay cannot drift from
 * the candles it is drawn over. These are overlay semantics, not palette
 * surfaces, so they stay literal; `entry`/`stop`/`target` are exported as-is
 * for the dashboard that builds the price lines.
 */
export const OVERLAY_COLORS = {
  entry: '#3B82F6',
  stop: '#EF4444',
  target: '#10B981',
} as const;

/** One horizontal level drawn across the chart. */
export interface ChartPriceLine {
  price: number;
  title: string;
  color: string;
  lineStyle?: 'solid' | 'dashed';
  lineWidth?: 1 | 2 | 3 | 4;
  axisLabelVisible?: boolean;
}

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
  /**
   * Horizontal order levels (entry / stop loss / take profit). Non-finite
   * prices are skipped — an order with no stop has no stop line, it does not
   * get one drawn at zero.
   */
  priceLines?: ChartPriceLine[];
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
  priceLines,
  isLoading = false,
  emptyMessage = 'No verified broker data for this instrument yet.',
}: CandlestickChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = React.useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLineRefs = React.useRef<IPriceLine[]>([]);

  /*
   * Live palette. The initial value is read from the DOM on the client — the
   * chart's own markup carries no colours, so this cannot cause a hydration
   * mismatch. `useThemeVersion` re-resolves it on a theme change and the palette
   * effect below pushes the new values into the chart instance.
   */
  const themeVersion = useThemeVersion();
  const [theme, setTheme] = React.useState<ChartTheme>(resolveChartTheme);
  React.useEffect(() => {
    setTheme(resolveChartTheme());
  }, [themeVersion]);

  /* Create + dispose the chart exactly once. */
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initial = resolveChartTheme();

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: initial.background },
        textColor: initial.text,
        fontSize: 11,
        fontFamily: initial.fontFamily,
        // Left ON deliberately: the lightweight-charts licence requires an
        // attribution link to tradingview.com, and this logo satisfies it.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: initial.grid, style: LineStyle.Solid },
        horzLines: { color: initial.grid, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: initial.border, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: { borderColor: initial.border, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: initial.crosshair, width: 1, style: LineStyle.Dashed },
        horzLine: { color: initial.crosshair, width: 1, style: LineStyle.Dashed },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    /*
     * Volume histogram, added lazily and only ever fed real numbers.
     *
     * Broker history carries `tickVolume` for many instruments (see the adapter)
     * and it is plotted as-is; bars built from streamed ticks have no volume at
     * all, so they contribute nothing rather than a fabricated "1 trade" bar.
     * The series is hidden entirely when the loaded history has no volumes.
     */
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeriesRef.current = volume;

    const series = chart.addCandlestickSeries({
      upColor: initial.upColor,
      downColor: initial.downColor,
      borderUpColor: initial.upColor,
      borderDownColor: initial.downColor,
      wickUpColor: initial.wickUp,
      wickDownColor: initial.wickDown,
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
      volumeSeriesRef.current = null;
      priceLineRefs.current = [];
    };
    // `height` is applied in its own effect below, so re-creating the chart is
    // not required when only the size changes; `theme` is read at creation time
    // and re-applied by the palette effect, so it is not a dependency either.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Keep the plot height in sync with the prop. */
  React.useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  /* Re-apply the palette when the theme changes (no chart re-creation). */
  React.useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: theme.background },
          textColor: theme.text,
          fontFamily: theme.fontFamily,
        },
        grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
        rightPriceScale: { borderColor: theme.border },
        timeScale: { borderColor: theme.border },
        crosshair: {
          vertLine: { color: theme.crosshair },
          horzLine: { color: theme.crosshair },
        },
      });
    }

    seriesRef.current?.applyOptions({
      upColor: theme.upColor,
      downColor: theme.downColor,
      borderUpColor: theme.upColor,
      borderDownColor: theme.downColor,
      wickUpColor: theme.wickUp,
      wickDownColor: theme.wickDown,
    });
  }, [theme]);

  /* Re-seed data whenever the candle array (or the palette) changes. */
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

    const volume = volumeSeriesRef.current;
    if (volume) {
      const volumes: HistogramData<UTCTimestamp>[] = candles
        .filter(
          (candle) =>
            Number.isFinite(candle.time) &&
            typeof candle.volume === 'number' &&
            Number.isFinite(candle.volume),
        )
        .map((candle) => ({
          time: candle.time as UTCTimestamp,
          value: candle.volume as number,
          color: candle.close >= candle.open ? theme.volumeUp : theme.volumeDown,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));

      volume.setData(volumes);
      // No broker volume for this series: hide the pane rather than draw zeros.
      volume.applyOptions({ visible: volumes.length > 0 });
    }

    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles, theme]);

  /* Draw the order overlay: entry / stop loss / take profit. */
  React.useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLineRefs.current) {
      try {
        series.removePriceLine(line);
      } catch {
        // Chart already disposed (unmount race) — nothing left to remove.
      }
    }
    priceLineRefs.current = [];

    for (const spec of priceLines ?? []) {
      if (!Number.isFinite(spec.price)) continue;
      priceLineRefs.current.push(
        series.createPriceLine({
          price: spec.price,
          color: spec.color,
          lineWidth: spec.lineWidth ?? 1,
          lineStyle: spec.lineStyle === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: spec.axisLabelVisible ?? true,
          title: spec.title,
        }),
      );
    }
  }, [priceLines]);

  const hasData = candles.length > 0;

  return (
    <div className={cn('surface flex flex-col overflow-hidden', className)}>
      {(symbol || timeframe) && (
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          {symbol ? <span className="text-sm font-semibold text-base-100">{symbol}</span> : null}
          {timeframe ? (
            <span className="rounded border border-line bg-base-800 px-1.5 py-0.5 font-mono text-[0.68rem] uppercase text-muted">
              {timeframe}
            </span>
          ) : null}
          <span className="ml-auto text-[0.68rem] text-muted">Market Feed</span>
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
