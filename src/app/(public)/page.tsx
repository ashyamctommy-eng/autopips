import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { listActivePlans } from '@/server/modules/account/account.service';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';
import { NonGuaranteedNote } from '@/components/shared/disclaimer';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { CtaBand } from '@/components/public/cta-band';
import { Hero } from '@/components/public/hero';
import { HowItWorks } from '@/components/public/how-it-works';
import { StrategyMetrics } from '@/components/public/strategy-metrics';
import { Transparency } from '@/components/public/transparency';

/**
 * Marketing home page.
 *
 * Async server component. The active plan list — with its LIVE verified
 * statistics — is read straight from the service layer, so the page has no HTTP
 * round trip to its own API and no client-side fetch.
 */

export const metadata: Metadata = {
  title: 'Automated trading infrastructure on MT4/MT5',
  description:
    'Autopipsz mirrors operator-run strategies from a master MetaTrader account into client-funded investments via MetaApi.cloud, with crypto settlement through NOWPayments. Targets are indicative and non-guaranteed; capital is at risk.',
  alternates: { canonical: '/' },
};

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const plans = await listActivePlans();

  return (
    <>
      <Hero />

      <Section
        id="strategies"
        width="wide"
        eyebrow="Strategies"
        title="Active strategies and their verified records"
        description="Each card below is a real, active plan. The track-record block is populated only from closed broker deals — where there is no history yet, the card says so."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/strategies">
              Strategy mechanics
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      >
        <div className="mb-5">
          <NonGuaranteedNote variant="banner" />
        </div>
        <StrategyMetrics plans={plans} />
      </Section>

      <HowItWorks />

      <Transparency />

      <Section width="wide" className="pt-0">
        <div
          role="note"
          className="rounded-xl border border-warn/30 bg-warn/[0.07] p-6 sm:p-8"
        >
          <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
            Capital is at risk
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
            Trading leveraged instruments can lose money quickly, and losses can exceed the capital
            allocated to a single strategy. Targets shown anywhere on this site are strategy
            objectives derived from historical broker data — they are not a promise, a projection or
            a commitment, and no return is guaranteed. Past performance is not indicative of future
            results.
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            {TARGET_RETURN_DISCLAIMER}
          </p>
          <div className="mt-4">
            <Button variant="outline" size="sm" asChild>
              <Link href="/risk">
                Read the full risk disclosure
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </Section>

      <Section width="wide" className="pt-0">
        <CtaBand />
      </Section>
    </>
  );
}
