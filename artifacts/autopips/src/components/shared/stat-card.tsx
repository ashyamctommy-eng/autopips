import * as React from 'react';

import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { renderIcon, type IconProp } from '@/components/ui/icon';
import { TrendingDown, TrendingUp } from 'lucide-react';

export interface StatCardDelta {
  /** Pre-formatted change, e.g. `+4.21%` or `-$120.00`. */
  value: React.ReactNode;
  /** Drives the colour. Defaults to `up`. */
  direction?: 'up' | 'down';
  /** Small caption after the delta, e.g. "vs yesterday". */
  label?: React.ReactNode;
}

export interface StatCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode;
  /** Pre-rendered value — pass `<Usd />`, `<TargetRange />`, or plain text. */
  value: React.ReactNode;
  delta?: StatCardDelta;
  icon?: IconProp;
  /** Secondary line under the value (e.g. the ledger formula). */
  footer?: React.ReactNode;
  /** Show a shimmer instead of the value while the snapshot loads. */
  loading?: boolean;
  /** Width of the loading shimmer. */
  loadingClassName?: string;
}

/**
 * Headline KPI card. Never receives a number it has to format itself — the
 * caller passes the rendered value, so money/percent semantics (and the
 * target-return caveat) stay in the components that own them.
 */
export function StatCard({
  label,
  value,
  delta,
  icon,
  footer,
  loading = false,
  loadingClassName,
  className,
  ...props
}: StatCardProps) {
  const renderedIcon = renderIcon(icon, 'size-4');
  const deltaDirection = delta?.direction ?? 'up';

  return (
    <Card className={cn('overflow-hidden', className)} {...props}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        {renderedIcon ? (
          <span aria-hidden className="shrink-0 text-muted">
            {renderedIcon}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-5 pt-0">
        {loading ? (
          <Skeleton className={cn('h-7 w-32', loadingClassName)} />
        ) : (
          <div className="text-2xl font-semibold leading-none tracking-tight text-base-100">
            {value}
          </div>
        )}
        <div className="flex items-center gap-2">
          {delta ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium tabular-nums',
                deltaDirection === 'up' ? 'text-profit-400' : 'text-loss-400',
              )}
            >
              {deltaDirection === 'up' ? (
                <TrendingUp aria-hidden className="size-3" />
              ) : (
                <TrendingDown aria-hidden className="size-3" />
              )}
              {delta.value}
            </span>
          ) : null}
          {delta?.label ? <span className="text-xs text-muted">{delta.label}</span> : null}
        </div>
        {footer ? <div className="text-xs leading-relaxed text-muted">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}
