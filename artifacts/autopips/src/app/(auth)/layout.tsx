import type { Metadata } from '@/lib/next/types';
import Link from '@/lib/next/link';
import { ArrowLeft } from 'lucide-react';

import { BrandMark } from '@/components/shared/brand-mark';
import { CookieConsent } from '@/components/public/cookie-consent';

/**
 * Authentication route group — `(auth)`.
 *
 * A focused, centred shell for `/login` and `/register`: the public site's
 * texture (grid + brand glow) without its navigation, so signing in is not a
 * detour into the marketing funnel. Server component; it holds no session state
 * and fetches nothing.
 *
 * The footer posture card ("How this platform handles your data") was removed on
 * 2026-10-10 at the operator's request. The security posture is documented on the
 * public Risk and Terms pages, so removing it from the auth shell loses nothing.
 */

export const metadata: Metadata = {
  // Auth surfaces are not content: keep them out of search results.
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid-backdrop min-h-screen bg-base-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:border-line focus:bg-base-850 focus:px-4 focus:py-2 focus:text-sm focus:text-base-100"
      >
        Skip to content
      </a>

      <div className="glow-top flex min-h-screen flex-col">
        <header className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-6 sm:px-6 lg:px-8">
          <Link
            href="/"
            aria-label="Baltimore Capital home"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70"
          >
            <BrandMark size="md" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Back to site
          </Link>
        </header>

        <main id="main" className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
      <CookieConsent />
    </div>
  );
}
