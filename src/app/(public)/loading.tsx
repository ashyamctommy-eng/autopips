import * as React from 'react';

import { Section } from '@/components/shared/section';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state for the public route group.
 *
 * Mirrors the shape of the real page (hero band, section heading, a two-column
 * card grid) so the layout does not jump when the live plan list resolves. It
 * contains no text and no figures: a shimmering box must never look like a
 * value.
 */
export default function PublicLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the public site.</span>

      <div className="grid-backdrop border-b border-line">
        <div className="glow-top">
          <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-16 sm:px-6 sm:pb-20 sm:pt-20 lg:px-8">
            <Skeleton className="h-6 w-64 rounded-full" />
            <Skeleton className="mt-5 h-10 w-full max-w-3xl" />
            <Skeleton className="mt-3 h-10 w-full max-w-2xl" />
            <Skeleton className="mt-6 h-5 w-full max-w-2xl" />
            <div className="mt-8 flex flex-wrap gap-3">
              <Skeleton className="h-11 w-44 rounded-md" />
              <Skeleton className="h-11 w-52 rounded-md" />
            </div>
            <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>

      <Section width="wide" eyebrow="Strategies" title="Active strategies and their verified records">
        <Skeleton className="mb-5 h-20 w-full rounded-lg" />
        <div className="mb-5 flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-28 rounded-md" />
          ))}
        </div>
        <ul className="grid gap-5 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <li key={index}>
              <Card>
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-6 w-24 rounded-full" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-16 w-full rounded-lg" />
                  </div>
                  <Skeleton className="h-20 w-full rounded-lg" />
                  <Skeleton className="h-28 w-full rounded-lg" />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
