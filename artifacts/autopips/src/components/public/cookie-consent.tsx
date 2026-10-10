'use client';

import * as React from 'react';
import { Cookie } from 'lucide-react';

import Link from '@/lib/next/link';
import { cn } from '@/lib/utils';

/**
 * Cookie consent banner.
 *
 * Shown once per browser until a choice is stored (localStorage, versioned so a
 * change to the policy can re-prompt). Two honest choices: accept all cookies,
 * or allow only the strictly-necessary ones. The platform's own session cookie
 * is strictly necessary and cannot be declined while signed in, so "essential
 * only" is a real, meaningful option rather than a fake one — and because there
 * are currently no advertising or third-party analytics cookies, both choices
 * behave identically today. The stored value is what a future analytics tag
 * would gate on.
 *
 * Rendered from the public and auth layouts. A "Cookie preferences" control in
 * the footer dispatches {@link OPEN_COOKIE_SETTINGS_EVENT} to re-open it.
 */

const STORAGE_KEY = 'bbcap-cookie-consent-v1';
export const OPEN_COOKIE_SETTINGS_EVENT = 'bbcap:cookie-settings';

type Choice = 'all' | 'essential';

interface Stored {
  choice: Choice;
  at: string;
}

function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    return parsed && (parsed.choice === 'all' || parsed.choice === 'essential') ? parsed : null;
  } catch {
    return null;
  }
}

export function CookieConsent() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!readStored()) setOpen(true);
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
  }, []);

  const decide = React.useCallback((choice: Choice) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice, at: new Date().toISOString() }));
    } catch {
      /* storage blocked — treat as dismissed for this page view only */
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[80] p-3 sm:p-4"
    >
      <div className="mx-auto w-full max-w-[1400px] rounded-xl border border-line bg-base-850/95 p-4 shadow-raised backdrop-blur sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
            <Cookie aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-base-100">We use cookies</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Strictly-necessary cookies keep you signed in and secure. We do not use advertising
              cookies, and no third-party analytics cookies are set. You can accept all cookies or
              allow only the essential ones — see our{' '}
              <Link
                href="/privacy"
                className="rounded-sm text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
              >
                Privacy policy
              </Link>
              .
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => decide('essential')}
              className="inline-flex h-9 items-center justify-center rounded-md border border-line bg-base-900 px-3 text-sm font-medium text-base-100 transition-colors hover:bg-base-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Essential only
            </button>
            <button
              type="button"
              onClick={() => decide('all')}
              className="inline-flex h-9 items-center justify-center rounded-md bg-cta px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            >
              Accept all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Footer control that re-opens the banner so a visitor can change their choice. */
export function CookiePreferencesButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT))}
      className={cn(
        'rounded-sm text-left transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
        className,
      )}
    >
      Cookie preferences
    </button>
  );
}
