import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Calculator, Gauge, ListChecks, ShieldAlert, XCircle } from 'lucide-react';

import { listActivePlans } from '@/server/modules/account/account.service';
import { NonGuaranteedNote } from '@/components/shared/disclaimer';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { CtaBand } from '@/components/public/cta-band';
import { StrategyMetrics } from '@/components/public/strategy-metrics';

/**
 * Strategies deep dive.
 *
 * The mechanics sections are the point of this page: how a master-account
 * signal becomes a client position, what is checked before an order is sent,
 * and how the platform charges. The strategy cards come from the live service
 * layer and carry their own verified stats.
 */

export const metadata: Metadata = {
  title: 'Strategies',
  description:
    'How Autopipsz executes strategies: master-to-client lot allocation, the nine pre-trade risk checks, high-water-mark performance fees and the limits of what the platform claims.',
  alternates: { canonical: '/strategies' },
};

export const dynamic = 'force-dynamic';

const LOT_FORMULA =
  'Client Lot Size = Master Lot Size × (Client Investment Capital / Master Account Equity)';

const RISK_CHECKS: readonly { name: string; detail: string }[] = [
  {
    name: 'Account active',
    detail:
      'The broker must report the account as tradeable and not be in a terminal error state.',
  },
  {
    name: 'Broker connected',
    detail: 'The connection status must be CONNECTED before a signal is acted on.',
  },
  {
    name: 'Duplicate signal',
    detail: 'A signal id that has already been processed is refused, so a retry cannot double-open.',
  },
  {
    name: 'Master equity floor',
    detail: 'Master-account equity must be positive and above the configured floor.',
  },
  {
    name: 'Drawdown limit',
    detail:
      'Realised peak-to-current drawdown is computed against deployed capital and must remain inside the plan’s limit; an unevaluable drawdown is treated as breached.',
  },
  {
    name: 'Open position cap',
    detail: 'The number of open positions must be below the configured maximum.',
  },
  {
    name: 'Lot validation',
    detail:
      'Signal volume must be positive and within the maximum lot per order, and the allocated client volume is floored to the symbol’s volume step.',
  },
  {
    name: 'Symbol tradable',
    detail: 'The broker must report the symbol as tradable.',
  },
  {
    name: 'Margin',
    detail: 'Required margin must be known and no greater than free margin on the account.',
  },
];

const NOT_CLAIMED: readonly string[] = [
  'No guaranteed returns. A target range is a strategy objective that may not be reached, and the strategy may lose money instead.',
  'No fixed daily, weekly or monthly profit. Nothing on this platform pays a fixed rate for holding capital.',
  'No withdrawal of unrealised gains. Only realised P/L that is backed by closed broker deals and unused capital become withdrawable.',
  'No capital protection and no insurance. A drawdown limit reduces exposure; it does not eliminate loss, and gaps or slippage can move past it.',
];

export default async function StrategiesPage() {
  const plans = await listActivePlans();

  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'Strategies' }]}
          eyebrow="Strategies"
          title="How the strategies are executed"
          description="Autopipsz runs operator-configured strategies on a master Deriv account and mirrors the resulting positions into client-funded investments. This page documents the arithmetic, the safety checks and the fee model."
        />
      </div>

      <Section
        width="wide"
        eyebrow="Live strategies"
        title="Active strategies and their verified records"
        description="Filter by risk level or search by name. Every figure in a track-record block is derived from closed broker deals."
      >
        <div className="mb-5">
          <NonGuaranteedNote variant="banner" />
        </div>
        <StrategyMetrics plans={plans} />
      </Section>

      <Section
        width="wide"
        eyebrow="Mechanics"
        title="Master-to-client lot allocation"
        description="One master account trades; each funded investment receives a proportional slice of that position."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                  <Calculator aria-hidden className="size-4" />
                </span>
                <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  The formula, exactly as it is implemented
                </h3>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm leading-relaxed text-muted">
              <p className="overflow-x-auto rounded-lg border border-line bg-base-900/70 p-4 font-mono text-sm text-base-100">
                {LOT_FORMULA}
              </p>
              <p>
                The result is then floored down to the symbol&rsquo;s volume step and bounded by the
                symbol&rsquo;s minimum and maximum volume. Flooring is deliberate: rounding up would
                hand a client more exposure than their share of the position justifies. If the
                computed volume falls below the broker minimum for that symbol, the allocation is
                skipped and the reason is recorded rather than approximated.
              </p>
              <p>
                Each order carries a deterministic client order id that is passed to the broker as
                the position comment, in the form{' '}
                <span className="font-mono text-base-100">sig:&lt;signalId&gt;:inv:&lt;investmentId&gt;</span>.
                That tag is how a broker position and its eventual closing deal are tied back to the
                investment that funded it — the same tag the synchroniser uses to write realised
                P/L.
              </p>
              <p>
                Every position is opened with a protective stop derived from recent broker candle
                data and a target at a fixed reward-to-risk multiple of that stop distance. Those
                levels are attached at order time; they are broker instructions, not promises about
                where the market will go.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                  <Gauge aria-hidden className="size-4" />
                </span>
                <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  Signal generation
                </h3>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm leading-relaxed text-muted">
              <p>
                Signals are evaluated against candles fetched from the broker bridge on each sync
                cycle. The rule in use is a trend-following cross confirmed by momentum:
              </p>
              <p className="rounded-lg border border-line bg-base-900/70 p-3 text-xs leading-relaxed text-base-100">
                BUY/SELL on EMA(fast) crossing EMA(slow) on the last broker candle, confirmed by
                RSI(period) staying inside [oversold, overbought]. No cross, or an RSI outside the
                bounds, yields no signal.
              </p>
              <p>
                Periods, symbols, timeframes and the master lot size are operator configuration.
                They are not a data source and contain no price history: every value the engine acts
                on comes from the broker at evaluation time.
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section
        width="wide"
        eyebrow="Risk controls"
        title="What is checked before an order is sent"
        description="The gate is fail-closed: every check is evaluated, and anything that cannot be evaluated counts as a rejection."
      >
        <Card>
          <CardContent className="p-5">
            <ol className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {RISK_CHECKS.map((check, index) => (
                <li key={check.name} className="flex gap-3">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-base-800 text-xs font-medium text-brand-300">
                    {index + 1}
                  </span>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium text-base-100">{check.name}</h3>
                    <p className="text-sm leading-relaxed text-muted">{check.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Alert variant="info" className="mt-5">
          <AlertTitle>Drawdown limits reduce exposure — they do not remove risk</AlertTitle>
          <AlertDescription>
            A breach stops new orders for the investment; it does not restore capital already lost.
            Market gaps can also carry a position past its stop level, so a realised loss may exceed
            the intended limit.
          </AlertDescription>
        </Alert>
      </Section>

      <Section
        width="wide"
        eyebrow="Fees"
        title="How performance and management fees are charged"
        description="Fees are deducted from the investment and recorded in the audit log under their own action."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                  <ListChecks aria-hidden className="size-4" />
                </span>
                <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  Performance fee, with a high-water mark
                </h3>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm leading-relaxed text-muted">
              <p>
                The performance fee applies only to profit that takes the investment to a new
                all-time high. The high-water mark is the higher of the funded capital and the peak
                equity recorded at the previous fee event:
              </p>
              <p className="overflow-x-auto rounded-lg border border-line bg-base-900/70 p-3 font-mono text-xs text-base-100">
                HWM = max(starting capital, peak equity)
                <br />
                fee = (current equity − HWM) × performance fee % ÷ 100, when current equity &gt; HWM
              </p>
              <p>
                If the investment is below its high-water mark, no performance fee is charged —
                including on the way back up to a level that was already paid for. Fees can never
                drive an investment&rsquo;s value below zero.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                  <ShieldAlert aria-hidden className="size-4" />
                </span>
                <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  Management fee, pro-rata
                </h3>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm leading-relaxed text-muted">
              <p>
                The management fee is charged on a day-count basis of 365 days, pro-rata for the
                period elapsed:
              </p>
              <p className="overflow-x-auto rounded-lg border border-line bg-base-900/70 p-3 font-mono text-xs text-base-100">
                fee = capital × (annual % ÷ 100) × (days elapsed ÷ 365)
              </p>
              <p>
                Zero elapsed days means a real zero fee, not a substituted value. Both fee figures
                for every plan are listed on each strategy card and on the plans page.
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section
        width="wide"
        eyebrow="Boundaries"
        title="What this platform does not do"
        description="These are negative commitments, not disclaimers bolted on at the end."
      >
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <ul className="flex flex-col gap-3">
              {NOT_CLAIMED.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted">
                  <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-loss-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-3 border-t border-line pt-4">
              <Button variant="outline" size="sm" asChild>
                <Link href="/risk">
                  Full risk disclosure
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/faq">Questions and answers</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section width="wide" className="pt-0">
        <CtaBand
          title="Review the plans before you commit capital"
          description="Plan terms — duration, investment range, target range, risk level and fees — are published for every active plan."
          primaryHref="/register"
          primaryLabel="Open an account"
          secondaryHref="/plans"
          secondaryLabel="Compare plans"
        />
      </Section>
    </>
  );
}
