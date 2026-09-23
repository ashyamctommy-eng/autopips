import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export const spinnerVariants = cva('animate-spin', {
  variants: {
    size: {
      sm: 'size-3.5',
      default: 'size-4',
      lg: 'size-6',
      xl: 'size-8',
    },
    tone: {
      default: 'text-base-100',
      muted: 'text-muted',
      brand: 'text-brand-400',
      profit: 'text-profit-400',
      loss: 'text-loss-400',
      warn: 'text-warn-400',
    },
  },
  defaultVariants: { size: 'default', tone: 'muted' },
});

export interface SpinnerProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'ref'>,
    VariantProps<typeof spinnerVariants> {
  /** Accessible label announced by screen readers. */
  label?: string;
}

export function Spinner({ className, size, tone, label = 'Loading', ...props }: SpinnerProps) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center">
      <Loader2 aria-hidden className={cn(spinnerVariants({ size, tone }), className)} {...props} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
