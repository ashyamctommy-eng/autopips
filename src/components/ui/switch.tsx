'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const switchRootVariants = cva(
  'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-line transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 focus-visible:ring-offset-base-900 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-brand/40 data-[state=checked]:bg-brand-500 data-[state=unchecked]:bg-base-700',
  {
    variants: {
      size: {
        sm: 'h-4 w-7',
        default: 'h-5 w-9',
        lg: 'h-6 w-11',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
    VariantProps<typeof switchRootVariants> {}

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, size, ...props }, ref) => (
    <SwitchPrimitive.Root ref={ref} className={cn(switchRootVariants({ size }), className)} {...props}>
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-knob shadow-card ring-0 transition-transform',
          size === 'sm' && 'size-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5',
          (size === 'default' || size === undefined) &&
            'size-4 data-[state=checked]:translate-x-[1.15rem] data-[state=unchecked]:translate-x-0.5',
          size === 'lg' && 'size-5 data-[state=checked]:translate-x-[1.4rem] data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = SwitchPrimitive.Root.displayName;
