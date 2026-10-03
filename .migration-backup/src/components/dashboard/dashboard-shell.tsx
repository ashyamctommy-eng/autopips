'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import type { TopbarNotification, TopbarUser } from '@/components/layout/topbar';
import type { KycStatusValue } from '@/types/api';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Thin client boundary around {@link AppShell}.
 *
 * `AppShell` is a client component that wants an `onSignOut` *callback*, and a
 * callback cannot cross the server → client boundary. The dashboard layout is a
 * server component, so it renders this wrapper: the layout keeps owning the
 * data (session, KYC status, notifications) and the wrapper owns the one
 * interactive behaviour the shell needs — a real `POST /api/v1/auth/logout`
 * followed by a redirect.
 *
 * `showToaster={false}` because the root layout's `AppProviders` already mounts
 * a single `<Toaster />`; two viewports would render every toast twice.
 */
export interface DashboardShellProps {
  /** Display identity for the topbar (from the server session). */
  user: TopbarUser;
  /** Drives the sidebar's KYC reminder. */
  kycStatus: KycStatusValue;
  /** Real audit events, mapped by the layout. Empty when there are none. */
  notifications: TopbarNotification[];
  children: React.ReactNode;
}

export function DashboardShell({
  user,
  kycStatus,
  notifications,
  children,
}: DashboardShellProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = React.useCallback(() => {
    if (signingOut) return;
    setSigningOut(true);
    void (async () => {
      try {
        await apiFetch('/api/v1/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
      } catch {
        // The route is idempotent and always clears cookies; a network error
        // still has to land the user on the sign-in page rather than strand
        // them inside a shell whose session may already be gone.
      } finally {
        router.replace('/login');
        router.refresh();
      }
    })();
  }, [router, signingOut]);

  return (
    <AppShell
      variant="client"
      user={user}
      kycStatus={kycStatus}
      notifications={notifications}
      onSignOut={handleSignOut}
      showToaster={false}
    >
      {children}
    </AppShell>
  );
}

export default DashboardShell;
