import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/shared/brand-mark';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';

/**
 * Public site footer.
 *
 * Server component — no hooks, no interactivity. The year is read at render
 * time. Nothing here states a statistic: the platform has no user counts, AUM
 * totals, award badges or partner logos to show, so it shows none.
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
  { href: '/terms', label: 'Terms of service' },
  { href: '/privacy', label: 'Privacy policy' },
  { href: '/risk', label: 'Risk disclosure' },
  { href: '/faq#returns', label: 'Are returns guaranteed?' },
  { href: '/faq#data', label: 'Data we store' },
  { href: '/contact', label: 'Contact' },
];

/**
 * Role mailboxes on the platform domain. All three are monitored; the contact
 * form on /contact is the canonical channel and is recorded against this
 * platform's own audit log.
 */
export const CONTACT_LINES = [
  { label: 'Support', email: 'support@autopips.pro', blurb: 'Account, deposits, withdrawals and KYC.' },
  { label: 'Security', email: 'security@autopips.pro', blurb: 'Vulnerability reports and account compromise.' },
  { label: 'Compliance', email: 'compliance@autopips.pro', blurb: 'Identity review and regulatory enquiries.' },
] as const;

/** The single non-dismissible risk line, rendered on every public page. */
export const RISK_LINE =
  'Trading involves substantial risk of loss. Targets are indicative and non-guaranteed.';

export interface SiteFooterProps {
  className?: string;
}

export function SiteFooter({ className }: SiteFooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer className={cn('border-t border-line bg-base-950/60', className)}>
      <div className="mx-auto w-full max-w-[1400px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3">
            <BrandMark size="md" />
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Automated algorithmic trading infrastructure. Strategy capital executes on Deriv
              over its WebSocket API; deposits and payouts settle in crypto through NOWPayments.
            </p>
          </div>

          <nav aria-labelledby="footer-platform" className="flex flex-col gap-3">
            <h2 id="footer-platform" className="text-xs font-medium uppercase tracking-wide text-brand-300">
              Platform
            </h2>
            <ul className="flex flex-col gap-2">
              {FOOTER_PLATFORM_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="rounded-sm text-sm text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-labelledby="footer-legal" className="flex flex-col gap-3">
            <h2 id="footer-legal" className="text-xs font-medium uppercase tracking-wide text-brand-300">
              Legal
            </h2>
            <ul className="flex flex-col gap-2">
              {FOOTER_LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="rounded-sm text-sm text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex flex-col gap-3">
            <h2 id="footer-contact" className="text-xs font-medium uppercase tracking-wide text-brand-300">
              Contact
            </h2>
            <ul className="flex flex-col gap-3">
              {CONTACT_LINES.map((line) => (
                <li key={line.email} className="flex flex-col gap-0.5">
                  <a
                    href={`mailto:${line.email}`}
                    className="rounded-sm text-sm text-base-100 transition-colors hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                  >
                    {line.label} — {line.email}
                  </a>
                  <span className="text-xs leading-relaxed text-muted">{line.blurb}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-line pt-6">
          <p className="text-xs leading-relaxed text-muted">{TARGET_RETURN_DISCLAIMER}</p>
          <p
            role="note"
            className="text-xs font-medium leading-relaxed text-warn-400"
            title="Non-dismissible risk statement"
          >
            {RISK_LINE}
          </p>
          <div className="flex flex-col gap-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
            <p>© {year} Autopipsz. All rights reserved.</p>
            <p>
              Autopipsz is not a bank and client balances are not insured. Nothing on this site is
              investment advice.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
