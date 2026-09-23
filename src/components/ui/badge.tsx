import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-line bg-base-700/70 text-base-100',
        brand: 'border-brand/30 bg-brand/10 text-brand-300',
        success: 'border-profit/30 bg-profit/10 text-profit-400',
        warn: 'border-warn/30 bg-warn/10 text-warn-400',
        danger: 'border-loss/30 bg-loss/10 text-loss-400',
        outline: 'border-line bg-transparent text-muted',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
