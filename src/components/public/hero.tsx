import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, KeyRound, Landmark, PlugZap, ScrollText, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Public hero.
 *
 * Server component. Every claim in the trust strip is an operational fact about
 * this codebase (broker-sourced P/L, manual KYC review, NOWPayments settlement,
 * Argon2id + TOTP 2FA, an append-only audit log). There is deliberately no
 * user count, no AUM figure, no uptime percentage, no award and no partner
 * logo — this platform has published none of those, so the hero states none.
 */

interface TrustFact {
  icon: LucideIcon;
  label: string;
}

const TRUST_FACTS: readonly TrustFact[] = [
  { icon: PlugZap, label: 'Broker-sourced P/L' },
  { icon: ShieldCheck, label: 'Manual KYC review' },
  { icon: Landmark, label: 'Crypto settlement via NOWPayments' },
  { icon: KeyRound, label: 'Argon2id + TOTP 2FA' },
  { icon: ScrollText, label: 'Append-only audit log' },
];

export interface HeroProps {
  className?: string;
}

export function Hero({ className }: HeroProps) {
  return (
    <section className={className}>
      <div className="grid-backdrop border-b border-line">
        <div className="glow-top">
          <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-16 sm:px-6 sm:pb-20 sm:pt-20 lg:px-8">
            <div className="max-w-3xl">
              <Badge variant="brand" className="mb-5">
                Broker APIs · Deriv
              </Badge>

              <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-base-100 sm:text-4xl lg:text-5xl">
                Automated algorithmic trading infrastructure, executed on MT4 and MT5 accounts
              </h1>

              <p className="mt-5 max-w-2xl text-pretty text-[1rem] leading-relaxed text-muted sm:text-lg">
                Autopipsz runs operator-configured strategies on a master Deriv account and
                mirrors every position into client-funded investments over Deriv&rsquo;s WebSocket API. P/L is
                read back from settled broker contracts, settlements clear in crypto through NOWPayments, and
                every state change lands in an append-only audit log.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button variant="primary" size="lg" asChild>
                  <Link href="/strategies">
                    View strategies
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" asChild>
                  <Link href="#transparency">How settlement works</Link>
                </Button>
              </div>

              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-warn-400">
                Targets are indicative objectives, not a promise. Capital is at risk and can be lost
                in full.
              </p>
            </div>

            <ul
              aria-label="How the platform works, in short"
              className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            >
              {TRUST_FACTS.map((fact) => {
                const Icon = fact.icon;
                return (
                  <li
                    key={fact.label}
                    className="flex items-center gap-3 rounded-lg border border-line bg-base-850/60 px-3 py-3 text-sm text-base-100 shadow-card backdrop-blur-sm"
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-brand-400" />
                    <span className="leading-snug">{fact.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
