import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NonGuaranteedNote } from '@/components/shared/disclaimer';

/**
 * Closing call to action, reused by the home, strategies and plans pages.
 *
 * Server component. It renders the mandatory non-guarantee caveat itself, so a
 * page cannot place this block without also placing the caveat.
 */

export interface CtaBandProps {
  title?: string;
  description?: React.ReactNode;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  className?: string;
}

export function CtaBand({
  title = 'Open an account and allocate capital to a strategy',
  description = 'Registration, manual identity review and crypto funding are all self-service. You can review every strategy and its verified track record before you commit any capital.',
  primaryHref = '/register',
  primaryLabel = 'Open an account',
  secondaryHref = '/plans',
  secondaryLabel = 'Compare plans',
  className,
}: CtaBandProps) {
  return (
    <div className={cn('grid-backdrop rounded-xl border border-line bg-base-850/50 p-6 sm:p-8', className)}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100 sm:text-xl">
            {title}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
          <div className="mt-4">
            <NonGuaranteedNote />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" asChild>
            <Link href={primaryHref}>
              {primaryLabel}
              <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href={secondaryHref}>{secondaryLabel}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
