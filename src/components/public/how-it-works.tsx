import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Coins, LineChart, ShieldCheck, UserPlus, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';

/**
 * The five-step client flow.
 *
 * Each step links to the page that actually carries it, so the flow doubles as
 * a navigation aid. Steps 2–4 are self-service in the client area; the links
 * point at the public page that documents the step for a visitor who is not
 * signed in yet.
 */

interface Step {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  href: string;
  linkLabel: string;
}

const STEPS: readonly Step[] = [
  {
    icon: UserPlus,
    title: 'Create your account',
    description:
      'Register with an email address and a password, and enable TOTP two-factor authentication. Passwords are stored as Argon2id hashes; there is no plaintext credential anywhere in the platform.',
    href: '/register',
    linkLabel: 'Register',
  },
  {
    icon: ShieldCheck,
    title: 'Verify your identity',
    description:
      'Upload your identity document, a proof of address and a selfie. Reviews are performed by a human reviewer against the stored documents. You must be at least 18 years old.',
    href: '/faq#kyc',
    linkLabel: 'What KYC needs',
  },
  {
    icon: Coins,
    title: 'Fund your account with crypto',
    description:
      'Request a deposit and you receive a unique payment address for that order. Funds are credited only after the provider reports the payment confirmed on-chain — not when the transfer is broadcast.',
    href: '/faq#deposits',
    linkLabel: 'How deposits credit',
  },
  {
    icon: Wallet,
    title: 'Allocate capital to a strategy',
    description:
      'Choose an active plan within its stated minimum and maximum, and confirm. Capital is then deployed to the strategy’s broker account and mirrored per the lot allocation formula, subject to the pre-trade risk gate.',
    href: '/plans',
    linkLabel: 'Compare plans',
  },
  {
    icon: LineChart,
    title: 'Track performance and withdraw',
    description:
      'Positions, equity and P/L are read from broker events and shown live in your account. You can pause or close an investment, and withdraw a balance backed by the ledger.',
    href: '/faq#withdrawals',
    linkLabel: 'How withdrawals work',
  },
];

export interface HowItWorksProps {
  className?: string;
}

export function HowItWorks({ className }: HowItWorksProps) {
  return (
    <Section
      id="how-it-works"
      width="wide"
      eyebrow="How it works"
      title="From registration to settlement"
      description="Five steps, each of which happens in the platform rather than by request over email."
      className={className}
    >
      <ol className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="flex">
              <div
                className={cn(
                  'flex w-full flex-col gap-3 rounded-xl border border-line bg-base-850/70 p-5 shadow-card',
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                    <Icon className="size-4" />
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    Step {index + 1}
                  </span>
                </div>
                <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted">{step.description}</p>
                <Button variant="link" size="sm" asChild className="mt-auto self-start">
                  <Link href={step.href}>
                    {step.linkLabel}
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
