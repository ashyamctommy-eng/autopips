'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const labelVariants = cva(
  'text-sm font-medium leading-none text-base-100 peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
  {
    variants: {
      muted: {
        true: 'text-muted',
        false: '',
      },
    },
    defaultVariants: { muted: false },
  },
);

export interface LabelProps
  extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>,
    VariantProps<typeof labelVariants> {}

export const Label = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, LabelProps>(
  ({ className, muted, ...props }, ref) => (
    <LabelPrimitive.Root ref={ref} className={cn(labelVariants({ muted }), className)} {...props} />
  ),
);
Label.displayName = LabelPrimitive.Root.displayName;
