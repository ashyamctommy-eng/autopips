'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { Spinner } from '@/components/ui/spinner';

/**
 * Completes the sign-out handshake.
 *
 * `/api/v1/auth/logout` is POST-only on purpose (it revokes the session server
 * side), and a plain `<a href>` from the top bar can only issue a GET. So the
 * menu links here, and this component performs the POST, then lands the operator
 * on the login screen.
 */
export default function SignOut() {
  const router = useRouter();
  const [failed, setFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch('/api/v1/auth/logout', {
          method: 'POST',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Sign-out failed (${response.status}).`);
        if (!cancelled) {
          router.replace('/login');
          router.refresh();
        }
      } catch (error) {
        if (!cancelled) {
          setFailed(error instanceof Error ? error.message : 'Sign-out failed.');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      {failed ? (
        <>
          <p className="text-sm font-medium text-base-100">Sign-out did not complete</p>
          <p className="max-w-md text-sm text-muted">{failed}</p>
          <button
            type="button"
            className="text-sm text-brand-400 underline underline-offset-4"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <Spinner size="lg" tone="brand" label="Signing out" />
          <p className="text-sm text-muted">Ending your session…</p>
        </>
      )}
    </div>
  );
}
