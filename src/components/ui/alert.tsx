import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export const alertVariants = cva(
  'relative flex w-full gap-3 rounded-lg border p-4 text-sm [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        info: 'border-brand/30 bg-brand/[0.07] text-base-100 [&_svg]:text-brand-400',
        success: 'border-profit/30 bg-profit/[0.07] text-base-100 [&_svg]:text-profit-400',
        warn: 'border-warn/30 bg-warn/[0.07] text-base-100 [&_svg]:text-warn-400',
        danger: 'border-loss/30 bg-loss/[0.07] text-base-100 [&_svg]:text-loss-400',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const ALERT_ICONS: Record<NonNullable<AlertVariant>, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleAlert,
};

type AlertVariant = 'info' | 'success' | 'warn' | 'danger';

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** Override the default per-variant icon, or pass `null` to hide it. */
  icon?: LucideIcon | null;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'info', icon, children, ...props }, ref) => {
    const Icon = icon === undefined ? ALERT_ICONS[variant ?? 'info'] : icon;
    return (
      <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
        {Icon ? <Icon className="mt-0.5" aria-hidden /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      </div>
    );
  },
);
Alert.displayName = 'Alert';

export const AlertTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5 ref={ref} className={cn('font-medium leading-none tracking-tight', className)} {...props} />
));
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm leading-relaxed text-muted', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';
