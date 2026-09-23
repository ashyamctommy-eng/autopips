'use client';

import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      'fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 outline-none sm:max-w-sm',
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

export const toastVariants = cva(
  [
    'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-4 pr-8 shadow-card',
    'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2',
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full',
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-out',
  ],
  {
    variants: {
      variant: {
        default: 'border-line bg-base-850 text-base-100',
        info: 'border-brand/40 bg-base-850 text-base-100',
        success: 'border-profit/40 bg-base-850 text-base-100',
        warn: 'border-warn/40 bg-base-850 text-base-100',
        danger: 'border-loss/40 bg-base-850 text-base-100',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>,
    VariantProps<typeof toastVariants> {}

export const Toast = React.forwardRef<React.ElementRef<typeof ToastPrimitive.Root>, ToastProps>(
  ({ className, variant, ...props }, ref) => (
    <ToastPrimitive.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
  ),
);
Toast.displayName = ToastPrimitive.Root.displayName;

export const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Action
    ref={ref}
    className={cn(
      'inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-line bg-base-800 px-3 text-xs font-medium text-base-100 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitive.Action.displayName;

export const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    aria-label="Dismiss"
    className={cn(
      'absolute right-2 top-2 rounded-md p-1 text-muted transition-colors hover:bg-base-700 hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
      className,
    )}
    {...props}
  >
    <X className="size-3.5" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

export const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title
    ref={ref}
    className={cn('text-sm font-medium leading-tight text-base-100', className)}
    {...props}
  />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

export const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted', className)}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;
