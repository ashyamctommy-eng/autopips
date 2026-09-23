import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Shimmering placeholder. Pass explicit dimensions (`h-4 w-24`) to match the
 * real content box — a skeleton must never imply a value.
 */
export const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    aria-hidden
    className={cn('relative overflow-hidden rounded-md bg-base-700/60', className)}
    {...props}
  >
    <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-base-100/5 to-transparent" />
  </div>
));
Skeleton.displayName = 'Skeleton';
