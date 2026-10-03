'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';
import { isNavItemActive, type NavItem } from '@/components/layout/sidebar';
import { ADMIN_NAV } from '@/components/layout/admin-sidebar';

/**
 * Sticky bottom navigation for the ADMIN console — mobile only (`lg:hidden`).
 *
 * WHY IT EXISTS
 *   Below `lg` the console's only navigation was the topbar hamburger, which
 *   opens a ten-item drawer: fine as a directory, wrong for an operator who is
 *   on a phone during an incident and needs to reach the screens that change
 *   platform state. This puts those under the thumb.
 *
 * THE FIVE DESTINATIONS, AND WHY THESE
 *   Overview  /admin              what the platform is doing right now — AUM,
 *                                 the equity identity and the broker snapshot.
 *   KYC       /admin/kyc          the compliance queue that blocks client money.
 *   Payouts   /admin/withdrawals  the single human gate that lets funds leave.
 *   Bot       /admin/bot-control  the emergency stop and the risk limits.
 *   Users     /admin/users        find the account behind an incident.
 *   Together they are the operate-the-platform loop: see state, stop the engine,
 *   clear the two money queues, locate a user. The other ADMIN_NAV entries
 *   (plans, brokers, audit, settings) are configuration or forensics rather than
 *   thumb-reach actions, and stay in the drawer.
 *
 * NO RAISED CENTRE, unlike the client bar. The client bar elevates Trade because
 * it is the one action the product exists for; these five are peers, and
 * promoting one would be arbitrary. A flat bar also keeps the console visually
 * distinct from the client shell, which matters because both render through
 * {@link AppShell}.
 *
 * ROUTES ARE REAL BY CONSTRUCTION: every item is looked up in `ADMIN_NAV`, so a
 * destination here can only be a route the sidebar already links. A missing
 * entry fails at module load instead of rendering a dead tab.
 */

interface AdminMobileNavItem extends NavItem {
  /** Compact label — the bar is wide enough for one short word, not two. */
  shortLabel: string;
}

const DESTINATIONS = [
  { href: '/admin', shortLabel: 'Overview' },
  { href: '/admin/kyc', shortLabel: 'KYC' },
  { href: '/admin/withdrawals', shortLabel: 'Payouts' },
  { href: '/admin/bot-control', shortLabel: 'Bot' },
  { href: '/admin/users', shortLabel: 'Users' },
] as const;

export const ADMIN_MOBILE_NAV: AdminMobileNavItem[] = DESTINATIONS.map(({ href, shortLabel }) => {
  const entry = ADMIN_NAV.find((item) => item.href === href);
  if (!entry) {
    throw new Error(`Admin bottom nav destination ${href} is not present in ADMIN_NAV.`);
  }
  return { ...entry, shortLabel };
});

export function AdminMobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-base-900/85 backdrop-blur-xl lg:hidden',
        // Safe-area inset for the iOS home indicator; 0 everywhere else.
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-1">
        {ADMIN_MOBILE_NAV.map((item) => {
          const active = isNavItemActive(pathname, item);
          const Icon = item.icon;

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md px-1 py-2 transition-colors',
                  active ? 'text-brand-300' : 'text-muted hover:text-base-100',
                )}
              >
                <Icon aria-hidden className="size-5" />
                <span className="text-[0.62rem] font-medium tracking-wide">{item.shortLabel}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default AdminMobileNav;
