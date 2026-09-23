'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';

import { cn } from '@/lib/utils';
import { formatUsd, type Numeric } from '@/lib/money';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { BarChart3 } from 'lucide-react';

export interface PlBarDatum {
  /** Category label (day, instrument, plan…). Passed through as-is. */
  label: string;
  value: Numeric;
}

export interface PlBarProps {
  /** Realised P/L buckets supplied by the caller. Never generated here. */
  data: PlBarDatum[];
  height?: number;
  className?: string;
  isLoading?: boolean;
  emptyMessage?: React.ReactNode;
  /** Label shown in the tooltip above the value. */
  valueLabel?: string;
}

const PROFIT = '#10B981';
const LOSS = '#F43F5E';

const AXIS_STYLE = {
  fontSize: 11,
  fill: 'rgba(148,163,184,0.65)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

interface BarTooltipProps extends TooltipProps<number, string> {
  valueLabel: string;
}

function BarTooltip({ active, payload, label, valueLabel }: BarTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.value;
  const numeric = typeof point === 'number' ? point : 0;
  return (
    <div className="rounded-lg border border-line bg-base-850 px-3 py-2 shadow-card">
      <p className="text-[0.68rem] text-muted">{String(label ?? '')}</p>
      <p
        className={cn(
          'text-sm font-medium tabular-nums',
          numeric < 0 ? 'text-loss-400' : 'text-profit-400',
        )}
      >
        {valueLabel} {numeric < 0 ? '-' : '+'}${formatUsd(Math.abs(numeric))}
      </p>
    </div>
  );
}

/**
 * Signed P/L bars: green for gains, rose for losses, with a zero baseline.
 * The caller owns the buckets — an empty array renders an empty state.
 */
export function PlBar({
  data,
  height = 220,
  className,
  isLoading = false,
  emptyMessage = 'No realised P/L for this period yet.',
  valueLabel = 'P/L',
}: PlBarProps) {
  const hasData = data.length > 0;

  const chartData = React.useMemo(
    () =>
      data.map((datum) => ({
        label: datum.label,
        value: typeof datum.value === 'number' ? datum.value : Number(datum.value.toString()),
      })),
    [data],
  );

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border border-line bg-base-850/70 shadow-card', className)}>
      <div className="relative" style={{ height }}>
        {isLoading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-base-850/60">
            <Spinner size="lg" tone="brand" label="Loading P/L" />
          </div>
        ) : null}
        {!hasData && !isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <EmptyState size="sm" icon={BarChart3} title="No P/L data" description={emptyMessage} />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS_STYLE}
                tickLine={false}
                axisLine={{ stroke: 'rgba(148,163,184,0.14)' }}
                minTickGap={16}
              />
              <YAxis
                tick={AXIS_STYLE}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) => `${value < 0 ? '-' : ''}$${formatUsd(Math.abs(value))}`}
              />
              <Tooltip
                content={<BarTooltip valueLabel={valueLabel} />}
                cursor={{ fill: 'rgba(148,163,184,0.06)' }}
              />
              <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chartData.map((datum) => (
                  <Cell key={datum.label} fill={datum.value < 0 ? LOSS : PROFIT} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
