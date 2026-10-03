import * as React from 'react';

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { renderIcon, type IconProp } from '@/components/ui/icon';
import { TrendingDown, TrendingUp } from 'lucide-react';

export type MetricTileTone = 'neutral' | 'profit' | 'loss' | 'warn' | 'brand';

const TONE_TEXT: Record<MetricTileTone, string> = {
  neutral: 'text-base-100',
  profit: 'text-profit-400',
  loss: 'text-loss-400',
  warn: 'text-warn-400',
  brand: 'text-brand-300',
};

export interface MetricTileProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode;
  /** Pre-rendered value (a `<Usd />`, `<Pct />`, count, …). */
  value: React.ReactNode;
  /** Tiny caption under the value. */
  sub?: React.ReactNode;
  /** Optional movement indicator; colours itself, `tone` still wins for `value`. */
  delta?: { value: React.ReactNode; direction?: 'up' | 'down' };
  icon?: IconProp;
  tone?: MetricTileTone;
  loading?: boolean;
}

/**
 * The compact 4-across KPI tile (dashboards, admin AUM strip).
 * Lighter than StatCard: no header row, no footer.
 */
export function MetricTile({
  label,
  value,
  sub,
  delta,
  icon,
  tone = 'neutral',
  loading = false,
  className,
  ...props
}: MetricTileProps) {
  const renderedIcon = renderIcon(icon, 'size-3.5');
  const direction = delta?.direction ?? 'up';

  return (
    <div
      className={cn('surface flex flex-col gap-1.5 p-4', className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        {renderedIcon ? (
          <span aria-hidden className="shrink-0 text-muted">
            {renderedIcon}
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <div className={cn('text-lg font-semibold leading-none tabular-nums', TONE_TEXT[tone])}>
          {value}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {delta ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
              direction === 'up' ? 'text-profit-400' : 'text-loss-400',
            )}
          >
            {direction === 'up' ? (
              <TrendingUp aria-hidden className="size-3" />
            ) : (
              <TrendingDown aria-hidden className="size-3" />
            )}
            {delta.value}
          </span>
        ) : null}
        {sub ? <span className="truncate text-xs text-muted">{sub}</span> : null}
      </div>
    </div>
  );
}
