import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Icon slot helper used by EmptyState / StatCard / MetricTile.
 *
 * Page teams may pass a lucide component (`icon={Wallet}`) or an already
 * rendered element (`icon={<Wallet className="size-4" />}`) — both work, so the
 * kit never forces one style.
 */
export type IconProp = LucideIcon | React.ReactNode;

function isComponentLike(value: unknown): value is React.ComponentType<{ className?: string }> {
  if (typeof value === 'function') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in (value as Record<string, unknown>) &&
    !React.isValidElement(value)
  );
}

/** Renders an `IconProp` at the given className, or `null` when unset. */
export function renderIcon(icon: IconProp | undefined, className = 'size-4'): React.ReactNode {
  if (!icon) return null;
  if (React.isValidElement(icon)) return icon;
  if (isComponentLike(icon)) {
    const Component = icon;
    return <Component className={className} />;
  }
  return null;
}

export interface IconSlotProps extends React.HTMLAttributes<HTMLSpanElement> {
  icon?: IconProp;
  iconClassName?: string;
}

/** A sized, muted square that frames an icon consistently across the kit. */
export function IconSlot({ icon, className, iconClassName, ...props }: IconSlotProps) {
  const rendered = renderIcon(icon, cn('size-4', iconClassName));
  if (!rendered) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-muted',
        className,
      )}
      {...props}
    >
      {rendered}
    </span>
  );
}
