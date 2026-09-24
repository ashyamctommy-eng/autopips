'use client';

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useSessionKeepAlive } from '@/lib/session-refresh';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { AdminSidebar } from '@/components/layout/admin-sidebar';
import { ClientSidebar } from '@/components/layout/sidebar';
import { Topbar, type TopbarNotification, type TopbarUser } from '@/components/layout/topbar';
import type { KycStatusValue } from '@/types/api';

export interface AppShellProps {
  /** `client` renders the trading dashboard nav, `admin` the back-office nav. */
  variant?: 'client' | 'admin';
  children: React.ReactNode;
  /** Passed through to the client sidebar's KYC reminder. */
  kycStatus?: KycStatusValue;
  user?: TopbarUser;
  notifications?: TopbarNotification[];
  /** Live bot/broker status slot. */
  botStatus?: React.ReactNode;
  onSignOut?: () => void;
  signOutHref?: string;
  /** Pending KYC count badge (admin only). */
  pendingKycCount?: number;
  /** Pending withdrawal count badge (admin only). */
  pendingWithdrawalCount?: number;
  /** Mount the toast viewport. Default true — disable if the page has its own. */
  showToaster?: boolean;
  /** Applied to the `<main>` element. */
  contentClassName?: string;
  className?: string;
}

/**
 * The application shell: dark grid background, glow gradients, a collapsible
 * sidebar (static from `lg`, drawer below), the sticky top bar and the main
 * content region.
 *
 * Pages render inside `<main>` and own their own `Section` padding. The shell
 * never renders a page-level heading.
 */
export function AppShell({
  variant = 'client',
  children,
  kycStatus,
  user,
  notifications,
  botStatus,
  onSignOut,
  signOutHref,
  pendingKycCount,
  pendingWithdrawalCount,
  showToaster = true,
  contentClassName,
  className,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Mounted once for both dashboards: the access token expires after 15 minutes,
  // and until this existed nothing in the browser ever renewed it.
  useSessionKeepAlive();

  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const sidebar =
    variant === 'admin' ? (
      <AdminSidebar pendingKycCount={pendingKycCount} pendingWithdrawalCount={pendingWithdrawalCount} />
    ) : (
      <ClientSidebar kycStatus={kycStatus} />
    );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'relative min-h-screen bg-base text-base-100',
          // The console runs the light executive palette. The class scopes the
          // token override in globals.css — `html:has(.theme-admin)`, so Radix
          // portals rendered onto <body> get it too.
          variant === 'admin' && 'theme-admin',
          className,
        )}
      >
        {/* Design-system background: subtle grid + top glow. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 bg-grid-dark [background-size:28px_28px]"
        />
        <div
          aria-hidden
          className={cn(
            'pointer-events-none fixed inset-x-0 top-0 h-80',
            variant === 'admin' ? 'bg-glow-emerald' : 'bg-glow-cyan',
          )}
        />

        <div className="relative flex min-h-screen">
          <div className="sticky top-0 hidden h-screen lg:block">{sidebar}</div>

          {mobileOpen ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
                className="absolute inset-0 bg-scrim backdrop-blur-sm"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                className="absolute inset-y-0 left-0 flex shadow-card animate-in slide-in-from-left-2"
              >
                {variant === 'admin' ? (
                  <AdminSidebar
                    collapsed={false}
                    showCollapseToggle={false}
                    pendingKycCount={pendingKycCount}
                    pendingWithdrawalCount={pendingWithdrawalCount}
                  />
                ) : (
                  <ClientSidebar collapsed={false} showCollapseToggle={false} kycStatus={kycStatus} />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close navigation"
                  onClick={() => setMobileOpen(false)}
                  className="absolute -right-11 top-3 size-9 text-base-100"
                >
                  <X />
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar
              botStatus={botStatus}
              notifications={notifications}
              user={user}
              onSignOut={onSignOut}
              signOutHref={signOutHref}
              onToggleSidebar={() => setMobileOpen(true)}
            />
            <main className={cn('flex-1', contentClassName)}>{children}</main>
          </div>
        </div>

        {showToaster ? <Toaster /> : null}
      </div>
    </TooltipProvider>
  );
}

export default AppShell;
