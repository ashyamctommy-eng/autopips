import * as React from 'react';

import { SiteHeader } from '@/components/public/site-header';
import { SiteFooter } from '@/components/public/site-footer';

/**
 * Public (marketing) route group.
 *
 * A server component: the header is a thin client island for the active-link
 * highlight and the footer renders entirely on the server. The group is
 * anonymous — nothing in this tree reads a session, and nothing here imports a
 * server module except the pages that fetch the public plan list.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
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
      <SiteFooter />
    </div>
  );
}
