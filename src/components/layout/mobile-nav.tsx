'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CandlestickChart, House, LineChart, UserRound, Wallet } from 'lucide-react';

import { cn } from '@/lib/utils';
import { isNavItemActive, type NavItem } from '@/components/layout/sidebar';

/**
 * Sticky bottom navigation — mobile only (`lg:hidden`).
 *
 * WHY IT EXISTS
 *   Below `lg` the only way into the dashboard was the topbar hamburger, which
 *   opens a ten-item drawer: fine for reachability, useless for the four places a
 *   client actually lives. This puts the primary destinations under the thumb,
 *   which is how every mobile financial app is driven.
 *
 * THE FIVE ITEMS ARE ROUTES THAT EXIST
 *   Home   /dashboard            account overview
 *   Markets/dashboard/markets    instruments with live prices
 *   Trade  /dashboard/trading    the trading terminal (raised, centre)
 *   Wallet /dashboard/wallet     balances, deposits and withdrawals
 *   Account/dashboard/settings   profile and security
 *
 * TRADE IS THE CENTRE, RAISED. It is the one action the product exists for, so it
 * gets the accent fill and sits proud of the bar instead of looking like a fourth
 * tab. It is still a plain link — no hidden gesture, nothing that can trap a
 * keyboard user.
 *
 * LAYERING (the shell's z-index ladder, lowest to highest)
 *   topbar z-30 · this bar z-30 · sidebar drawer z-40 · dialogs/menus z-50 ·
 *   toasts z-[100]. The drawer covers this bar on purpose: the hamburger still
 *   opens the FULL menu, and two competing nav surfaces at once would be noise.
 *
 * SAFE AREA: padded with `env(safe-area-inset-bottom)` so it clears the iOS home
 * indicator. That value is only non-zero because the root `viewport` export sets
 * `viewportFit: 'cover'`.
 */

interface MobileNavItem extends NavItem {
  /** Compact label — the bar is wide enough for one word, not two. */
  shortLabel: string;
}

export const MOBILE_NAV: MobileNavItem[] = [
  { label: 'Home', shortLabel: 'Home', href: '/dashboard', icon: House, exact: true },
  { label: 'Markets', shortLabel: 'Markets', href: '/dashboard/markets', icon: LineChart },
  { label: 'Trade', shortLabel: 'Trade', href: '/dashboard/trading', icon: CandlestickChart },
  { label: 'Wallet', shortLabel: 'Wallet', href: '/dashboard/wallet', icon: Wallet },
  { label: 'Account', shortLabel: 'Account', href: '/dashboard/settings', icon: UserRound },
];

/** The centre item is rendered differently — kept in one place so they cannot drift. */
const CENTRE_HREF = '/dashboard/trading';

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-base-900/85 backdrop-blur-xl lg:hidden',
        // Safe-area inset for the iOS home indicator; 0 everywhere else.
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-1">
        {MOBILE_NAV.map((item) => {
          const active = isNavItemActive(pathname, item);
          const isCentre = item.href === CENTRE_HREF;
          const Icon = item.icon;

          if (isCentre) {
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  // The icon-only affordance is not enough on its own: the label
                  // stays visible so the destination is never a guess.
                  className="group flex flex-col items-center gap-1 pb-1.5 pt-0"
                >
                  <span
                    className={cn(
                      '-mt-4 flex size-11 items-center justify-center rounded-full border shadow-card transition-colors',
                      active
                        ? 'border-brand/60 bg-brand text-on-accent'
                        : 'border-brand/40 bg-cta text-on-accent group-hover:border-brand/60',
                    )}
                  >
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <span
                    className={cn(
                      'text-[0.62rem] font-medium tracking-wide',
                      active ? 'text-brand-300' : 'text-muted group-hover:text-base-100',
                    )}
                  >
                    {item.shortLabel}
                  </span>
                </Link>
              </li>
            );
          }

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

export default MobileNav;
