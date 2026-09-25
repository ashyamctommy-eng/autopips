import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, FileLock2, KeyRound, ShieldCheck, type LucideIcon } from 'lucide-react';

import { BrandMark } from '@/components/shared/brand-mark';

/**
 * Authentication route group — `(auth)`.
 *
 * A focused, centred shell for `/login` and `/register`: the public site's
 * texture (grid + cyan glow) without its navigation, so signing in is not a
 * detour into the marketing funnel. Server component; it holds no session state
 * and fetches nothing.
 *
 * The footer states the platform's actual security posture in the same words
 * the rest of the product uses — Argon2id password hashing, TOTP two-factor,
 * and identity documents encrypted at rest and readable only by a signed-in
 * administrator through an audited route. No counts, no badges, no claims: see
 * `src/components/public` for the rules this copy follows.
 */

export const metadata: Metadata = {
  // Auth surfaces are not content: keep them out of search results.
  robots: { index: false, follow: false },
};

interface PostureItem {
  icon: LucideIcon;
  title: string;
  detail: string;
}

const SECURITY_POSTURE: readonly PostureItem[] = [
  {
    icon: KeyRound,
    title: 'Argon2id password hashing',
    detail: 'Your password is stored as an Argon2id hash. Plaintext is never written or logged.',
  },
  {
    icon: ShieldCheck,
    title: 'TOTP two-factor available',
    detail:
      'Every account can enrol a time-based authenticator code as a second step at sign-in.',
  },
  {
    icon: FileLock2,
    title: 'Private document storage',
    detail:
      'Identity documents are encrypted at rest and stay inside the platform; only a signed-in administrator can open them, and every access is logged.',
  },
];

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
            aria-label="Autopipsz home"
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

        <footer className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl rounded-xl border border-line bg-base-850/40 p-5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-brand-300">
              How this platform handles your data
            </h2>
            <ul className="mt-4 grid gap-4 sm:grid-cols-3">
              {SECURITY_POSTURE.map((item) => (
                <li key={item.title} className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-base-100">
                    <item.icon aria-hidden className="size-4 shrink-0 text-brand-400" />
                    {item.title}
                  </span>
                  <span className="text-xs leading-relaxed text-muted">{item.detail}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-muted">
              Autopipsz is not a bank and client balances are not insured. Trading involves
              substantial risk of loss. Read the{' '}
              <Link
                href="/risk"
                className="rounded-sm text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
              >
                risk disclosure
              </Link>
              .
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
