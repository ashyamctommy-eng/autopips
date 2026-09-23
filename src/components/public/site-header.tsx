'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/shared/brand-mark';
import { Button } from '@/components/ui/button';

/**
 * Public site header.
 *
 * Client component for one reason only: the active link is derived from
 * `usePathname()`. It holds no data and fetches nothing — the anonymous
 * bundle stays free of anything that touches the server modules.
 */

export interface PublicNavItem {
  href: string;
  label: string;
}

/** The marketing navigation, in one place so the footer/QA can reuse it. */
export const PUBLIC_NAV: readonly PublicNavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/strategies', label: 'Strategies' },
  { href: '/plans', label: 'Plans' },
  { href: '/about', label: 'About' },
  { href: '/faq', label: 'FAQ' },
  { href: '/risk', label: 'Risk' },
  { href: '/contact', label: 'Contact' },
];

/**
 * `/` matches only the exact path; everything else also matches its children so
 * `/faq#deposits` and any future nested page keep the parent tab highlighted.
 */
export function isPublicNavActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

const MOBILE_NAV_ID = 'public-mobile-nav';

export interface SiteHeaderProps {
  className?: string;
}

export function SiteHeader({ className }: SiteHeaderProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Navigating away must never leave the panel hanging open.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <header
      className={cn(
        'sticky top-0 z-50 w-full border-b border-line bg-base-900/80 backdrop-blur',
        className,
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70"
          aria-label="Autopipsz home"
        >
          <BrandMark size="md" />
        </Link>

        <nav aria-label="Main" className="hidden lg:flex lg:flex-1 lg:items-center lg:gap-1">
          {PUBLIC_NAV.map((item) => {
            const active = isPublicNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                  active
                    ? 'bg-base-800 text-base-100'
                    : 'text-muted hover:bg-base-800/60 hover:text-base-100',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Button variant="ghost" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
          <Button variant="primary" asChild>
            <Link href="/register">Open an account</Link>
          </Button>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="ml-auto lg:hidden"
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_NAV_ID}
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X aria-hidden /> : <Menu aria-hidden />}
        </Button>
      </div>

      <div
        id={MOBILE_NAV_ID}
        hidden={!mobileOpen}
        className="border-t border-line bg-base-900/95 backdrop-blur lg:hidden"
      >
        <nav aria-label="Mobile" className="mx-auto flex w-full max-w-[1400px] flex-col gap-1 px-4 py-4 sm:px-6">
          {PUBLIC_NAV.map((item) => {
            const active = isPublicNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                  active ? 'bg-base-800 text-base-100' : 'text-muted hover:bg-base-800/60 hover:text-base-100',
                )}
              >
                {item.label}
              </Link>
            );
          })}
          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-4">
            <Button variant="outline" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button variant="primary" asChild>
              <Link href="/register">Open an account</Link>
            </Button>
          </div>
        </nav>
      </div>
    </header>
  );
}
