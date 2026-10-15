'use client';

import * as React from 'react';
import Link from '@/lib/next/link';
import { Mail, MessageCircle, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Floating support trigger (live chat entry point).
 *
 * The platform has no third-party chat widget, so this is the honest version of
 * one: a persistent button that opens a small panel with the real support
 * channels — the monitored role mailboxes and the contact form. Nothing here
 * pretends a human is online; it names the channel and how fast it answers.
 *
 * Positioned clear of the mobile bottom navigation (fixed, ~4rem tall below `lg`)
 * so it never sits under it, and capped to the viewport width so it cannot push
 * the page sideways on a phone.
 */

export interface SupportLine {
  label: string;
  email: string;
  blurb: string;
}

const DEFAULT_LINES: readonly SupportLine[] = [
  { label: 'Support', email: 'support@autopipsmarkets.com', blurb: 'Account, deposits, withdrawals and KYC.' },
  { label: 'Security', email: 'security@autopipsmarkets.com', blurb: 'Vulnerability reports and account compromise.' },
];

export interface SupportChatProps {
  /** Admin-editable contacts; falls back to the built-in mailboxes. */
  contacts?: readonly SupportLine[];
  className?: string;
}

export function SupportChat({ contacts, className }: SupportChatProps) {
  const [open, setOpen] = React.useState(false);
  const lines = contacts && contacts.length > 0 ? contacts : DEFAULT_LINES;

  return (
    <div className={cn('fixed bottom-20 right-4 z-40 flex flex-col items-end gap-3 lg:bottom-6', className)}>
      {open ? (
        <div
          role="dialog"
          aria-label="Support"
          className="w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-base-900/95 p-4 shadow-[0_18px_48px_-18px_rgba(0,0,0,0.7)] backdrop-blur"
        >
          <p className="text-sm font-semibold text-base-100">Talk to us</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            We reply to these mailboxes directly. For anything about your account, the contact form is
            the fastest route — it is recorded against our audit log.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {lines.map((line) => (
              <li key={line.email} className="flex flex-col gap-0.5">
                <a
                  href={`mailto:${line.email}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-base-100 hover:text-brand-300"
                >
                  <Mail aria-hidden className="size-3.5" />
                  {line.label}
                </a>
                <span className="text-xs text-muted">{line.blurb}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/contact"
            className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-md bg-brand px-3 text-sm font-semibold text-on-accent hover:opacity-90"
          >
            Open the contact form
          </Link>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close support' : 'Open support'}
        data-testid="support-chat-trigger"
        className="inline-flex items-center gap-2 rounded-full border border-line bg-base-900/95 px-3.5 py-2.5 text-sm font-semibold text-base-100 shadow-[0_14px_36px_-16px_rgba(0,0,0,0.75)] backdrop-blur transition-colors hover:border-brand/60 hover:text-brand-300"
      >
        {open ? <X aria-hidden className="size-4" /> : <MessageCircle aria-hidden className="size-4" />}
        <span className="hidden sm:inline">{open ? 'Close' : 'Support'}</span>
      </button>
    </div>
  );
}

export default SupportChat;
