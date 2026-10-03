'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const progressIndicatorVariants = cva('h-full w-full flex-1 transition-transform', {
  variants: {
    tone: {
      brand: 'bg-brand',
      profit: 'bg-profit',
      loss: 'bg-loss',
      warn: 'bg-warn',
      muted: 'bg-muted',
    },
  },
  defaultVariants: { tone: 'brand' },
});

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    VariantProps<typeof progressIndicatorVariants> {}

/**
 * Radix Progress. `value` is 0–100; pass `value={undefined}` for an
 * indeterminate bar rather than inventing a number.
 */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, tone, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-base-700/70', className)}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(progressIndicatorVariants({ tone }))}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
