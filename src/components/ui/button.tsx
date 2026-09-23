import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Autopipsz button.
 *
 * `default` and `secondary` are the two dark surfaces; `primary` is the cyan
 * call-to-action (reserve it — one per view); `success`/`destructive` are for
 * money-moving confirmations only.
 */
export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'font-medium leading-none transition-colors select-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base-900',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'border border-line bg-base-700 text-base-100 hover:bg-base-700/70',
        primary:
          'border border-brand/40 bg-brand-500 font-semibold text-base-950 hover:bg-brand-400 shadow-glow-cyan',
        secondary: 'border border-line bg-base-800 text-base-100 hover:bg-base-700',
        outline:
          'border border-line bg-transparent text-base-100 hover:border-brand/40 hover:bg-base-800',
        ghost: 'border border-transparent bg-transparent text-base-100 hover:bg-base-800',
        destructive: 'border border-loss/40 bg-loss-500 font-semibold text-base-950 hover:bg-loss-400',
        success: 'border border-profit/40 bg-profit-500 font-semibold text-base-950 hover:bg-profit-400',
        link: 'border border-transparent bg-transparent p-0 text-brand-400 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 gap-1.5 px-3 text-xs',
        default: 'h-9 px-4 text-sm',
        lg: 'h-11 gap-2 px-6 text-[1rem]',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>` (Radix Slot). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        // Only a real <button> gets a default type; spreading it onto a Slot
        // child would leak the attribute onto e.g. an <a>.
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
