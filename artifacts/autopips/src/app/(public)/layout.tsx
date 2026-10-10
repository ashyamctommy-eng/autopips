import * as React from 'react';

import { SiteHeader } from '@/components/public/site-header';
import { SiteFooter } from '@/components/public/site-footer';
import { CookieConsent } from '@/components/public/cookie-consent';
import { getPublicContactLines } from '@/lib/services/settings.service';

/**
 * Public (marketing) route group.
 *
 * A server component: the header is a thin client island for the active-link
 * highlight and the footer renders entirely on the server. The group is
 * anonymous — nothing in this tree reads a session, and nothing here imports a
 * server module except the pages that fetch the public plan list.
 *
 * The support mailboxes are admin-editable (Admin → Platform settings), read
 * through a whitelisted anonymous RPC. If that read fails the footer falls back
 * to its built-in defaults, so a settings outage never blanks the contact block.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  let contacts: Awaited<ReturnType<typeof getPublicContactLines>> | undefined;
  try {
    contacts = await getPublicContactLines();
  } catch {
    contacts = undefined;
  }

  return (
    <div className="flex min-h-screen flex-col bg-base-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:border-line focus:bg-base-850 focus:px-4 focus:py-2 focus:text-sm focus:text-base-100"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter contacts={contacts} />
      <CookieConsent />
    </div>
  );
}
