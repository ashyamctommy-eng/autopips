import * as React from 'react';

import { cn } from '@/lib/utils';

export const inputClassName =
  'flex h-9 w-full rounded-md border border-line bg-base-900/80 px-3 py-1 text-sm text-base-100 shadow-inner transition-colors placeholder:text-muted/70 focus-visible:border-brand/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-base-100';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(inputClassName, className)} {...props} />
  ),
);
Input.displayName = 'Input';
