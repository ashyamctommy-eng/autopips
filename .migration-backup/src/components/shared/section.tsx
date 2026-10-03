import * as React from 'react';

import { cn } from '@/lib/utils';

const WIDTH: Record<NonNullable<SectionProps['width']>, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-6xl',
  wide: 'max-w-[1400px]',
  full: 'max-w-none',
};

export interface SectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** Small uppercase label above the title. */
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header actions. */
  actions?: React.ReactNode;
  width?: 'narrow' | 'default' | 'wide' | 'full';
  /** Render as `<div>` instead of `<section>` (e.g. nested inside a section). */
  as?: 'section' | 'div';
}

/**
 * Page section wrapper: consistent max-width and padding so page teams never
 * write their own container classes.
 */
export function Section({
  eyebrow,
  title,
  description,
  actions,
  width = 'default',
  as: Comp = 'section',
  className,
  children,
  ...props
}: SectionProps) {
  const hasHeader = Boolean(eyebrow || title || description || actions);
  return (
    <Comp
      className={cn('mx-auto w-full px-4 py-6 sm:px-6 lg:px-8', WIDTH[width], className)}
      {...props}
    >
      {hasHeader ? (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-1">
            {eyebrow ? (
              <span className="text-xs font-medium uppercase tracking-wide text-brand-300">
                {eyebrow}
              </span>
            ) : null}
            {title ? (
              <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Comp>
  );
}
