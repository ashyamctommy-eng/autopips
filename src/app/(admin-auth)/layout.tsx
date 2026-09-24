import type { Metadata } from 'next';

/**
 * Console authentication shell — `(admin-auth)`.
 *
 * Its own route group for two structural reasons:
 *
 *   1. The page must NOT sit under `app/admin/layout.tsx`, which requires a
 *      staff session and redirects an anonymous visitor to the sign-in page —
 *      the console sign-in would redirect to itself, forever.
 *   2. It must NOT inherit `app/(auth)/layout.tsx` either: that is the client
 *      shell (dark surface, account-creation links, client-facing security
 *      posture). The console has its own light, restricted-area framing.
 *
 * The `theme-admin` class scopes the light palette. It is on a wrapper inside
 * <body>, and `globals.css` keys the override off `html:has(.theme-admin)`, so
 * the document (including portalled dialogs) is light before the first paint —
 * no theme flash, no layout shift.
 */

export const metadata: Metadata = {
  // Authentication surfaces are not content.
  robots: { index: false, follow: false },
};

export default function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-admin grid-backdrop flex min-h-screen flex-col bg-base-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:border-line focus:bg-base-850 focus:px-4 focus:py-2 focus:text-sm focus:text-base-100"
      >
        Skip to content
      </a>

      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="px-4 pb-8 text-center sm:px-6">
        <p className="text-xs leading-relaxed text-muted">
          © 2026 Autopipsz Systems. All administrative actions are recorded.
        </p>
      </footer>
    </div>
  );
}
