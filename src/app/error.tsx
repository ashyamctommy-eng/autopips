'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary.
 * Surfaces a reference the user can quote to support; the detailed message is
 * only shown outside production so a stack trace never reaches a client.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] route error', error.digest ?? '', error.message);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-loss/40 bg-loss/10">
        <AlertTriangle className="h-6 w-6 text-loss" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-base-100">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted">
          The platform could not complete that request. No balance or trade record was
          modified by a failed page load.
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-slate-500">reference: {error.digest}</p>
        ) : null}
        {process.env.NODE_ENV !== 'production' ? (
          <pre className="mx-auto mt-4 max-w-2xl overflow-auto rounded-lg border border-line bg-base-950 p-4 text-left text-xs text-loss/90">
            {error.message}
          </pre>
        ) : null}
      </div>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
