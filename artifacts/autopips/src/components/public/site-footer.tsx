import * as React from 'react';
import Link from '@/lib/next/link';

import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/shared/brand-mark';
import { CookiePreferencesButton } from '@/components/public/cookie-consent';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';

/**
 * Public site footer — a single compact dark banner.
 *
 * It used to be a four-column directory. A trading site's footer is not a site
 * map: it is the regulatory strip. What remains is what must remain — the legal
 * links (a compliance requirement, not decoration), the non-guarantee disclaimer,
 * the risk line, the copyright and the cookie-preferences control. The contact
 * mailboxes moved to the floating support trigger, which is where someone looking
 * for help actually looks.
 *
 * Nothing here states a statistic: the platform has no user counts, AUM totals,
 * awards or partner logos, so it shows none.
 */

export interface FooterLink {
  href: string;
  label: string;
}

export const FOOTER_PLATFORM_LINKS: readonly FooterLink[] = [
  { href: '/strategies', label: 'Strategies' },
  { href: '/plans', label: 'Plans' },
  { href: '/about', label: 'About' },
  { href: '/faq', label: 'FAQ' },
];

export const FOOTER_LEGAL_LINKS: readonly FooterLink[] = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/risk', label: 'Risk disclosure' },
  { href: '/contact', label: 'Contact' },
];

export const CONTACT_LINES = [
  { label: 'Support', email: 'support@autopipsmarkets.com', blurb: 'Account, deposits, withdrawals and KYC.' },
  { label: 'Security', email: 'security@autopipsmarkets.com', blurb: 'Vulnerability reports and account compromise.' },
  { label: 'Compliance', email: 'compliance@autopipsmarkets.com', blurb: 'Identity review and regulatory enquiries.' },
] as const;

/** The single non-dismissible risk line, rendered on every public page. */
export const RISK_LINE =
  'Trading involves substantial risk of loss. Targets are indicative and non-guaranteed.';

export interface SiteFooterProps {
  className?: string;
  /** Admin-editable direct-line mailboxes (Admin → Platform settings). */
  contacts?: readonly { label: string; email: string; blurb: string }[];
}

export function SiteFooter({ className }: SiteFooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer className={cn('border-t border-line bg-base-950', className)}>
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <BrandMark size="sm" />
              <span className="text-xs text-muted">© {year} Autopips Markets. All rights reserved.</span>
            </div>

            <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {FOOTER_LEGAL_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded-sm text-xs text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {link.label}
                </Link>
              ))}
              <span aria-hidden className="text-muted">
                ·
              </span>
              <CookiePreferencesButton className="text-xs text-muted" />
            </nav>
          </div>

          {/* Regulatory strip — the reason the footer exists. */}
          <p role="note" className="text-[0.7rem] leading-relaxed text-muted">
            <span className="font-medium text-warn-400" title="Non-dismissible risk statement">
              {RISK_LINE}
            </span>{' '}
            {TARGET_RETURN_DISCLAIMER} Autopips Markets is not a bank and client balances are not
            insured. Nothing on this site is investment advice.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
