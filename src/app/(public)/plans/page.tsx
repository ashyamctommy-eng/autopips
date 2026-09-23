import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Coins } from 'lucide-react';

import { listActivePlans } from '@/server/modules/account/account.service';
import { formatPercent } from '@/lib/money';
import { NonGuaranteedNote, TargetRange } from '@/components/shared/disclaimer';
import { Usd } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { RiskBadge } from '@/components/shared/risk-badge';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { CtaBand } from '@/components/public/cta-band';

/**
 * Plan comparison.
 *
 * Every plan on this page is read from the live service layer, so an inactive or
 * removed plan cannot linger here. If there are no active plans, the page says
 * exactly that — it never falls back to a sample plan.
 */

export const metadata: Metadata = {
  title: 'Plans',
  description:
    'Compare the active Autopipsz strategies: minimum and maximum investment, term, target range, risk level, drawdown limit and fee schedule. Targets are indicative and non-guaranteed.',
  alternates: { canonical: '/plans' },
};

export const dynamic = 'force-dynamic';

export default async function PlansPage() {
  const plans = await listActivePlans();

  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'Plans' }]}
          eyebrow="Plans"
          title="Compare the active plans"
          description="Each plan states its term, investment range, risk level, drawdown limit and fee schedule. Target ranges are strategy objectives — the full caveat is repeated on every card."
        />
      </div>

      <Section width="wide">
        <div className="mb-5">
          <NonGuaranteedNote variant="banner" />
        </div>

        {plans.length === 0 ? (
          <EmptyState
            icon={Coins}
            size="lg"
            title="No plans are active right now"
            description="Plan terms are published only once an operator has activated them, and they are read live from the platform database. There is no sample plan and no historical plan shown in its place."
            action={
              <Button variant="outline" asChild>
                <Link href="/contact">
                  Ask when new plans open
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            }
            className="surface"
          />
        ) : (
          <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {plans.map((plan) => (
              <li key={plan.id} className="flex">
                <Card className="flex w-full flex-col">
                  <CardHeader className="gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                        {plan.name}
                      </h3>
                      <RiskBadge level={plan.riskLevel} />
                    </div>
                    <p className="text-sm leading-relaxed text-muted">{plan.description}</p>
                  </CardHeader>

                  <CardContent className="flex flex-1 flex-col gap-4">
                    <dl className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                          Target range
                        </dt>
                        <dd className="text-lg font-semibold">
                          <TargetRange min={plan.targetReturnMin} max={plan.targetReturnMax} />
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
                        <dt className="text-xs text-muted">Term</dt>
                        <dd className="text-sm text-base-100">{plan.durationDays} days</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted">Minimum investment</dt>
                        <dd className="text-sm text-base-100">
                          <Usd value={plan.minInvestment} tone="neutral" />
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted">Maximum investment</dt>
                        <dd className="text-sm text-base-100">
                          <Usd value={plan.maxInvestment} tone="neutral" />
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted">Drawdown limit</dt>
                        <dd className="tabular-nums text-sm text-base-100">
                          {formatPercent(plan.maxDrawdown, 2)}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
                        <dt className="text-xs text-muted">Performance fee</dt>
                        <dd className="tabular-nums text-sm text-base-100">
                          {formatPercent(plan.performanceFee, 2)}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted">Management fee (annual)</dt>
                        <dd className="tabular-nums text-sm text-base-100">
                          {formatPercent(plan.managementFee, 2)}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-auto border-t border-line pt-4">
                      <p className="text-xs leading-relaxed text-muted">
                        Performance fees are charged only on profit above the investment&rsquo;s
                        high-water mark. Management fees are charged pro-rata on elapsed days.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section width="wide" className="pt-0">
        <Alert variant="warn">
          <AlertTitle>Read the fee and risk terms against your own circumstances</AlertTitle>
          <AlertDescription>
            A plan&rsquo;s drawdown limit caps how far a strategy may fall before it stops opening
            new positions; it does not cap your loss. Nothing on this page is investment advice, and
            no plan offers a fixed or guaranteed return. See the{' '}
            <Link href="/risk" className="text-brand-300 underline-offset-4 hover:underline">
              risk disclosure
            </Link>{' '}
            before allocating capital.
          </AlertDescription>
        </Alert>
      </Section>

      <Section width="wide" className="pt-0">
        <CtaBand
          title="Allocation is confirmed before any capital moves"
          description="You choose the amount within the plan's range and confirm it; capital is deployed to the strategy's broker account only after your identity review is approved."
          primaryHref="/register"
          primaryLabel="Open an account"
          secondaryHref="/faq"
          secondaryLabel="Read the FAQ"
        />
      </Section>
    </>
  );
}
