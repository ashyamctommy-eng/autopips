import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface BreadcrumbItem {
  label: React.ReactNode;
  /** Omit on the final (current) crumb. */
  href?: string;
}

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumb?: BreadcrumbItem[];
  /** Right-aligned buttons / filters. */
  actions?: React.ReactNode;
  /** Small label above the title, e.g. the account name or environment. */
  eyebrow?: React.ReactNode;
}

/** Standard page title block: breadcrumb, title, description, action slot. */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  eyebrow,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)} {...props}>
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {breadcrumb.map((crumb, index) => {
              const isLast = index === breadcrumb.length - 1;
              return (
                <li key={`${index}-${String(crumb.label)}`} className="flex items-center gap-1">
                  {index > 0 ? <ChevronRight aria-hidden className="size-3 text-muted/60" /> : null}
                  {crumb.href && !isLast ? (
                    <Link href={crumb.href} className="transition-colors hover:text-base-100">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className={cn(isLast && 'text-base-100')} aria-current={isLast ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          {eyebrow ? (
            <span className="text-xs font-medium uppercase tracking-wide text-brand-300">
              {eyebrow}
            </span>
          ) : null}
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-base-100 sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
