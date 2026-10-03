'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';

import { abbreviateUsd, cn } from '@/lib/utils';
import { formatUsd, type Numeric } from '@/lib/money';
import { MONOSPACE_FALLBACK, type TokenSpec } from '@/lib/theme';
import { useChartTheme } from '@/components/theme/use-theme-tokens';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { LineChart } from 'lucide-react';

export interface EquityPoint {
  /** X-axis label — an ISO timestamp or a short date; passed through as-is. */
  time: string;
  equity: Numeric;
}

export interface EquityCurveProps {
  /** Verified account-equity snapshots, oldest → newest. Never generated here. */
  data: EquityPoint[];
  height?: number;
  className?: string;
  isLoading?: boolean;
  /** Line colour. Defaults to the emerald `profit` token. */
  tone?: 'profit' | 'loss' | 'brand';
  emptyMessage?: React.ReactNode;
  /** Label shown in the tooltip above the value. */
  valueLabel?: string;
}

/**
 * Chart colours come from the design tokens (`globals.css`) rather than
 * literals, and `useThemeTokens` re-reads them on a palette change — so the
 * curve, grid and axes follow light/dark. Fallbacks are the dark palette and
 * cover the server render.
 */
const CHART_TOKENS = {
  tick: { token: '--chart-tick', fallback: 'rgba(148, 163, 184, 0.65)' },
  grid: { token: '--chart-grid', fallback: 'rgba(148, 163, 184, 0.06)' },
  axis: { token: '--chart-axis', fallback: 'rgba(148, 163, 184, 0.14)' },
  crosshair: { token: '--chart-crosshair', fallback: 'rgba(148, 163, 184, 0.35)' },
  profit: { token: '--c-profit-500', fallback: 'rgb(16, 185, 129)' },
  loss: { token: '--c-loss-500', fallback: 'rgb(244, 63, 94)' },
  brand: { token: '--c-brand-400', fallback: 'rgb(34, 211, 238)' },
} satisfies Record<string, TokenSpec>;

interface EquityTooltipContentProps extends TooltipProps<number, string> {
  valueLabel: string;
}

function EquityTooltip({ active, payload, label, valueLabel }: EquityTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.value;
  return (
    <div className="rounded-lg border border-line bg-base-850 px-3 py-2 shadow-card">
      <p className="text-[0.68rem] text-muted">{String(label ?? '')}</p>
      <p className="text-sm font-medium tabular-nums text-base-100">
        {valueLabel} ${typeof point === 'number' ? formatUsd(point) : '—'}
      </p>
    </div>
  );
}

/**
 * Equity curve. The series is always supplied by the caller (accounting
 * snapshot or `account:equity` socket payload) — this component never
 * interpolates or invents a point.
 */
export function EquityCurve({
  data,
  height = 260,
  className,
  isLoading = false,
  tone = 'profit',
  emptyMessage = 'No verified equity history yet.',
  valueLabel = 'Equity',
}: EquityCurveProps) {
  const gradientId = React.useId();
  const hasData = data.length > 0;

  const theme = useChartTheme(CHART_TOKENS, MONOSPACE_FALLBACK);

  const stroke = theme[tone];
  const axisStyle = React.useMemo(
    () => ({ fontSize: 11, fill: theme.tick, fontFamily: theme.fontFamily }),
    [theme.tick, theme.fontFamily],
  );

  const chartData = React.useMemo(
    () =>
      data.map((point) => ({
        time: point.time,
        equity: typeof point.equity === 'number' ? point.equity : Number(point.equity.toString()),
      })),
    [data],
  );

  return (
    <div className={cn('surface flex flex-col overflow-hidden', className)}>
      <div className="relative" style={{ height }}>
        {isLoading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-base-850/60">
            <Spinner size="lg" tone="brand" label="Loading equity history" />
          </div>
        ) : null}
        {!hasData && !isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <EmptyState size="sm" icon={LineChart} title="No equity history" description={emptyMessage} />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={theme.grid} vertical={false} />
              <XAxis
                dataKey="time"
                tick={axisStyle}
                tickLine={false}
                axisLine={{ stroke: theme.axis }}
                minTickGap={24}
              />
              <YAxis
                tick={axisStyle}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) => `$${abbreviateUsd(value)}`}
              />
              <Tooltip
                content={<EquityTooltip valueLabel={valueLabel} />}
                cursor={{ stroke: theme.crosshair, strokeDasharray: '4 4' }}
              />
              <Area
                type="monotone"
                dataKey="equity"
                stroke={stroke}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0, fill: stroke }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
