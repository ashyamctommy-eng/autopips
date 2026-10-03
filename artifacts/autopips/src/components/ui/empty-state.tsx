import * as React from 'react';

import { cn } from '@/lib/utils';
import { renderIcon, type IconProp } from '@/components/ui/icon';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Lucide component or element. */
  icon?: IconProp;
  /** Required — an empty state without a headline is a bug. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary/outline buttons or links. */
  action?: React.ReactNode;
  /** Secondary line under the action, e.g. a support link. */
  footer?: React.ReactNode;
  size?: 'sm' | 'default' | 'lg';
}

/**
 * EmptyState — the ONLY acceptable way to render "no data". Never fill a table,
 * chart or feed with invented rows.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footer,
  size = 'default',
  className,
  ...props
}: EmptyStateProps) {
  const renderedIcon = renderIcon(icon, size === 'lg' ? 'size-7' : 'size-5');
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        size === 'sm' && 'px-4 py-6',
        size === 'default' && 'px-6 py-10',
        size === 'lg' && 'px-6 py-16',
        className,
      )}
      {...props}
    >
      {renderedIcon ? (
        <span className="inline-flex size-11 items-center justify-center rounded-full border border-line bg-base-800 text-muted">
          {renderedIcon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-base-100">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
      {footer ? <div className="text-xs text-muted">{footer}</div> : null}
    </div>
  );
}
