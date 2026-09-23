'use client';

import * as React from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useToast, type ToastVariant } from '@/components/ui/use-toast';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

const VARIANT_ICONS: Record<Exclude<ToastVariant, 'default'>, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleAlert,
};

const VARIANT_ICON_CLASS: Record<Exclude<ToastVariant, 'default'>, string> = {
  info: 'text-brand-400',
  success: 'text-profit-400',
  warn: 'text-warn-400',
  danger: 'text-loss-400',
};

export interface ToasterProps {
  className?: string;
}

/**
 * Mount once per app (AppShell renders it). Reads the {@link useToast} store.
 */
export function Toaster({ className }: ToasterProps) {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(({ id, title, description, variant = 'default', action, duration, open }) => {
        const Icon = variant === 'default' ? null : VARIANT_ICONS[variant];
        return (
          <Toast
            key={id}
            open={open}
            duration={duration}
            variant={variant}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) dismiss(id);
            }}
            className={cn(variant !== 'default' && 'pl-3', className)}
          >
            {Icon ? (
              <Icon
                aria-hidden
                className={cn('mt-0.5 size-4 shrink-0', VARIANT_ICON_CLASS[variant as Exclude<ToastVariant, 'default'>])}
              />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {title ? <ToastTitle>{title}</ToastTitle> : null}
              {description ? <ToastDescription>{description}</ToastDescription> : null}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
