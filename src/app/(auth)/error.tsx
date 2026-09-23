'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Error boundary for the authentication route group.
 *
 * Scoped to `(auth)`: a failure while rendering the sign-in or registration
 * page keeps the auth layout (brand header, security footer) and offers a retry
 * instead of dumping the visitor onto the root error screen. Nothing about the
 * session is implied here — a failed page load does not sign anyone in or out,
 * because the session lives in cookies the API owns.
 *
 * The raw message is only rendered outside production, matching the root
 * boundary in `src/app/error.tsx`.
 */

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[auth] route error', error.digest ?? '', error.message);
  }, [error]);

  return (
    <div role="alert">
      <Card className="overflow-hidden">
        <div aria-hidden className="h-0.5 w-full bg-loss/70" />
        <div className="flex flex-col items-center gap-3 p-6 text-center sm:p-7">
          <span className="inline-flex size-11 items-center justify-center rounded-full border border-loss/40 bg-loss/10">
            <AlertTriangle aria-hidden className="size-5 text-loss-400" />
          </span>
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-base-100">
            This page could not load
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            The sign-in page failed to render. Your session was not changed by this — you can retry,
            or go back to the public site and try again.
          </p>
          {error.digest ? (
            <p className="font-mono text-xs text-muted">reference: {error.digest}</p>
          ) : null}
          {process.env.NODE_ENV !== 'production' ? (
            <pre className="mt-2 w-full overflow-auto rounded-lg border border-line bg-base-950 p-3 text-left text-xs text-loss-400/90">
              {error.message}
            </pre>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button variant="primary" onClick={reset}>
              <RotateCcw aria-hidden />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">
                <ArrowLeft aria-hidden />
                Back to site
              </Link>
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
