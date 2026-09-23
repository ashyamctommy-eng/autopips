import * as React from 'react';

import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/**
 * The shared shell for every authentication card.
 *
 * Presentational only — no state, no data, no `'use client'`. It exists so the
 * sign-in form, the two-factor step and the registration form render one visual
 * language: a hairline-bordered surface on the dark base, a thin brand-to-profit
 * accent line, a single `<h1>`, and an optional footer strip for cross-links.
 *
 * The card owns the page's only `<h1>`; callers must not render another one.
 */

export interface AuthCardProps {
  /** Becomes the page `<h1>`. */
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Cross-links ("No account yet?", "Forgot your password?"). */
  footer?: React.ReactNode;
  className?: string;
}

export function AuthCard({ title, description, children, footer, className }: AuthCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div
        aria-hidden
        className="h-0.5 w-full bg-gradient-to-r from-brand-400 via-brand to-profit"
      />
      <div className="flex flex-col gap-2 p-6 pb-0 sm:p-7 sm:pb-0">
        <h1 className="text-xl font-semibold leading-tight tracking-tight text-base-100 sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      <div className="p-6 sm:p-7">{children}</div>
      {footer ? (
        <div className="border-t border-line bg-base-900/40 px-6 py-4 text-sm text-muted sm:px-7">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
