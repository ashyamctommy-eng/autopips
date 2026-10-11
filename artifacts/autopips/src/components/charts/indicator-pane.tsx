'use client';

import * as React from 'react';
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { cn } from '@/lib/utils';
import type { IndicatorLine } from '@/lib/indicators';

/**
 * Sub-pane for oscillators (RSI, MACD).
 *
 * A separate chart instance rather than a second pane on the main one:
 * lightweight-charts v4 has no multi-pane API, and stacking an oscillator on the
 * price scale would squash both. The time scale is hidden so the two charts read
 * as one instrument view, with the price chart above and this beneath.
 */

export interface IndicatorPaneProps {
  lines: IndicatorLine[];
  title?: string;
  height?: number;
  className?: string;
}

export function IndicatorPane({ lines, title, height = 130, className }: IndicatorPaneProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<Map<string, ISeriesApi<'Line'> | ISeriesApi<'Histogram'>>>(new Map());

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 10,
        // The lightweight-charts licence requires the attribution link.
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.07)' },
        horzLines: { color: 'rgba(148,163,184,0.07)' },
      },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      timeScale: { borderColor: 'rgba(148,163,184,0.2)', timeVisible: true, secondsVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, [height]);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const wanted = new Set(lines.map((line) => line.id));
    for (const [id, series] of seriesRef.current) {
      if (wanted.has(id)) continue;
      chart.removeSeries(series);
      seriesRef.current.delete(id);
    }

    for (const line of lines) {
      let series = seriesRef.current.get(line.id);
      if (!series) {
        series =
          line.kind === 'histogram'
            ? chart.addHistogramSeries({ color: line.color, priceLineVisible: false, lastValueVisible: false })
            : chart.addLineSeries({
                color: line.color,
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              });
        seriesRef.current.set(line.id, series);
      } else {
        series.applyOptions({ color: line.color });
      }

      const data = line.data
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
        .map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
        .sort((a, b) => (a.time as number) - (b.time as number));

      if (line.kind === 'histogram') {
        (series as ISeriesApi<'Histogram'>).setData(
          data.map((point) => ({ ...point, color: point.value >= 0 ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)' })),
        );
      } else {
        (series as ISeriesApi<'Line'>).setData(data);
      }
    }
  }, [lines]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-line bg-base-900/40', className)}>
      {title ? (
        <span className="pointer-events-none absolute left-2 top-1.5 z-10 rounded bg-base-900/70 px-1 text-[0.65rem] text-muted">
          {title}
        </span>
      ) : null}
      <div ref={containerRef} />
    </div>
  );
}

export default IndicatorPane;
