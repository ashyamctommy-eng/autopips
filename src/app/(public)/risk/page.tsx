import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

import { TARGET_RETURN_DISCLAIMER, TARGET_RETURN_LABEL } from '@/lib/contracts';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Risk disclosure.
 *
 * This page is deliberately free of product marketing. It states the risks as
 * they are, including the ones the operator cannot control, and it claims no
 * licence, no authorisation and no capital protection. Nothing here is
 * investment advice.
 */

export const metadata: Metadata = {
  title: 'Risk disclosure',
  description:
    'Full risk disclosure for Autopipsz: capital at risk, leverage, targets as objectives, counterparty and broker risk, crypto settlement risk, regulatory status, fees, liquidity and technology risk.',
  alternates: { canonical: '/risk' },
};

interface RiskSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

const RISKS: readonly RiskSection[] = [
  {
    id: 'capital-at-risk',
    title: 'Capital at risk',
    body: (
      <>
        <p>
          Trading foreign exchange, metals, indices and other leveraged instruments carries a high
          level of risk. You can lose some or all of the money you allocate, and you should not
          allocate money you cannot afford to lose. Returns are variable and no outcome is assured.
        </p>
        <p>
          The capital you allocate is at risk from the moment it is deployed to a strategy. Autopipsz
          does not compensate losses, does not refund allocations that perform badly, and does not
          operate any scheme that would return your capital independently of trading results.
        </p>
      </>
    ),
  },
  {
    id: 'leverage',
    title: 'Leverage: losses can exceed the money you deposited',
    body: (
      <>
        <p>
          Positions are opened on leveraged broker accounts. Leverage multiplies both gains and
          losses, and a small adverse move in the underlying market can produce a large loss relative
          to the amount you allocated. If a broker account runs out of margin, the broker may close
          positions automatically at a loss, in its own discretion and without consulting you.
        </p>
        <p>
          Where your position size on the broker account, together with the broker&rsquo;s margin
          rules, permits a negative result, the loss can exceed the capital you allocated. Any
          figure you see about a &ldquo;maximum drawdown&rdquo; describes a control applied by this
          platform, not a contractual cap on your liability.
        </p>
      </>
    ),
  },
  {
    id: 'past-performance',
    title: 'Past performance is not indicative of future results',
    body: (
      <>
        <p>
          Where a strategy shows a track record, that record describes trades that have already
          closed. It says nothing about what the strategy will do next. Market conditions, liquidity
          and volatility change, and a strategy that performed well historically may perform badly —
          or lose money — in the future.
        </p>
        <p>
          Track records are computed from closed broker deals and are shown as observed results, not
          annualised or projected figures. A short track record is statistically weak, and a small
          number of closed trades can produce a result that is not repeatable.
        </p>
      </>
    ),
  },
  {
    id: 'targets',
    title: 'Targets are objectives, not promises',
    body: (
      <>
        <p>
          {TARGET_RETURN_LABEL}. Every target or indicative range published on this platform is a
          strategy objective derived from historical broker data. It is not a promise, a forecast, a
          commitment or a contractual entitlement, and it is not a limit on how much you may lose.
        </p>
        <p>{TARGET_RETURN_DISCLAIMER}</p>
        <p>
          Autopipsz does not offer fixed daily, weekly or monthly profit, does not offer any form of
          guaranteed return, and does not offer capital protection on any plan.
        </p>
      </>
    ),
  },
  {
    id: 'counterparty',
    title: 'Counterparty and broker risk',
    body: (
      <>
        <p>
          Autopipsz is not a broker, a bank or a venue. Orders are placed on MetaTrader 4 / MT5
          accounts held with a third-party broker through MetaApi.cloud, and those accounts are
          subject to the broker&rsquo;s terms. If the broker defaults, becomes insolvent, withdraws
          from a jurisdiction, changes its margin requirements or restricts trading, your capital
          and open positions can be affected, delayed or lost.
        </p>
        <p>
          The platform also depends on MetaApi.cloud as a connectivity provider between it and the
          broker. An outage or an API change at that provider can delay or prevent order placement,
          modification and closure, including the closing of a position you wanted to exit.
        </p>
      </>
    ),
  },
  {
    id: 'crypto-settlement',
    title: 'Crypto volatility and settlement risk',
    body: (
      <>
        <p>
          Deposits and payouts settle in cryptocurrency through NOWPayments. Crypto assets are
          volatile, unregulated in many jurisdictions and irreversible: a transfer sent to a wrong
          address cannot be recalled, and a payment sent on the wrong network may be permanently
          lost.
        </p>
        <p>
          Deposit amounts are denominated in USD-equivalent value, but the amount actually received
          is affected by the exchange rate and network fees at the time the transaction is processed,
          and by the confirmation policy of the relevant chain. Network congestion, chain
          reorganisations, provider downtime and payout delays can postpone the credit or the
          release of your money. A deposit is credited only when the payment is confirmed on chain.
        </p>
      </>
    ),
  },
  {
    id: 'regulatory',
    title: 'Regulatory status and the absence of advice',
    body: (
      <>
        <p>
          Nothing on this website or in the client area constitutes investment advice, a personal
          recommendation, a solicitation or an offer to buy or sell any financial instrument.
          Autopipsz does not assess your financial situation, objectives or risk tolerance, and does
          not provide tax or legal advice. Decisions you take are your own.
        </p>
        <p>
          Autopipsz does not claim on this website any licence, registration, authorisation or
          supervisory status in any jurisdiction. Whether managed trading of this kind may lawfully
          be offered to you — and whether any particular entity may lawfully offer it — depends on
          your country of residence and the applicable local rules. That must be confirmed with the
          operator, and if necessary with your own adviser, before you fund an account. If serving
          you would require a licence the operator does not hold, you should not open an account.
        </p>
        <p>
          Nothing on this site is an offer to residents of any jurisdiction where such an offer would
          be unlawful.
        </p>
      </>
    ),
  },
  {
    id: 'fees',
    title: 'Fees reduce your result',
    body: (
      <>
        <p>
          A performance fee is charged on profit above the investment&rsquo;s high-water mark and a
          management fee is charged pro-rata on capital deployed. Both are deducted from the
          investment, so they reduce the amount you can withdraw regardless of whether the strategy
          made money in a given period. The management fee is charged on capital at work even when
          the strategy loses money.
        </p>
        <p>
          The fee percentages for every active plan are published on the plans and strategies pages.
          Network and payout-provider costs on crypto transfers are additional and are outside the
          platform&rsquo;s control.
        </p>
      </>
    ),
  },
  {
    id: 'liquidity',
    title: 'Liquidity and withdrawal timing',
    body: (
      <>
        <p>
          Capital that is deployed in an active strategy is not withdrawable until it is released,
          and positions can only be closed when the market is open and the broker accepts the order.
          Illiquid conditions, weekend and holiday gaps, and market openings can all prevent an
          orderly exit and shift the price at which a position closes.
        </p>
        <p>
          Withdrawal requests are reviewed and broadcast through a payment provider, so they are not
          instantaneous even when your withdrawable balance is sufficient. Blockchains are
          irreversible, so a payout sent to an address you supplied incorrectly cannot be recovered.
        </p>
      </>
    ),
  },
  {
    id: 'technology',
    title: 'Technology, execution and operational risk',
    body: (
      <>
        <p>
          Automated systems fail. Connectivity between the platform, MetaApi.cloud and the broker can
          be interrupted; a strategy can be delayed, skipped or rejected; a scheduled process can
          stop; a deployment can introduce a defect. Order placement and closure depend on
          third-party infrastructure that Autopipsz does not control.
        </p>
        <p>
          Risk controls on this platform are applied at order time and are fail-closed, but no control
          eliminates the possibility of loss, slippage or an error. Market gaps can move a price past
          a stop level before an order can be filled, and the filled price may be materially worse
          than the intended level.
        </p>
      </>
    ),
  },
  {
    id: 'no-compensation',
    title: 'No insurance, no compensation scheme, no custody claim',
    body: (
      <>
        <p>
          Balances on Autopipsz are not bank deposits, are not insured by any deposit-protection or
          investor-compensation scheme, and are not protected by any guarantee fund. There is no
          government-backed protection if the operator, the broker or the payment provider fails.
        </p>
        <p>
          Client entitlement is tracked as an accounting position in the platform&rsquo;s ledger; it
          is not a legal trust and does not make Autopipsz a custodian. Segregation of client funds
          in the legal sense is not offered.
        </p>
      </>
    ),
  },
  {
    id: 'before-investing',
    title: 'Before you allocate capital',
    body: (
      <>
        <ul className="ml-4 list-disc space-y-2">
          <li>Read this disclosure and the fee schedule for the plan you are considering in full.</li>
          <li>Confirm the operator&rsquo;s regulatory status for your jurisdiction before funding.</li>
          <li>Assume that a total loss of allocated capital is possible, and size your allocation accordingly.</li>
          <li>Do not allocate borrowed money or money you need for essential expenses.</li>
          <li>Treat every track record and every target as historical information, not as a forecast.</li>
          <li>
            If anything on this site is unclear, ask through the{' '}
            <Link href="/contact" className="text-brand-300 underline-offset-4 hover:underline">
              contact form
            </Link>{' '}
            before you commit capital.
          </li>
        </ul>
      </>
    ),
  },
];

export default function RiskPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'Risk' }]}
          eyebrow="Risk disclosure"
          title="Risk disclosure"
          description="This page states the risks of using this platform as they are. It is not marketing material and it contains no product claims."
        />
      </div>

      <Section width="default">
        <Alert variant="danger" className="mb-6">
          <AlertTitle>You can lose the money you allocate, and you can lose more than it</AlertTitle>
          <AlertDescription>
            Leveraged trading can result in losses exceeding your allocated capital. Nothing on this
            platform guarantees a return, protects your capital or insures your balance. If you do
            not understand these risks, do not open an account.
          </AlertDescription>
        </Alert>

        <nav aria-label="Risk topics" className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-brand-300">
            On this page
          </h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {RISKS.map((risk) => (
              <li key={risk.id}>
                <a
                  href={`#${risk.id}`}
                  className="rounded-sm text-sm text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {risk.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex flex-col gap-4">
          {RISKS.map((risk) => (
            <Card key={risk.id} id={risk.id} className="scroll-mt-24">
              <CardContent className="flex flex-col gap-3 p-5">
                <h2 className="flex items-start gap-3 text-[1rem] font-semibold leading-snug tracking-tight text-base-100">
                  <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn-400" />
                  {risk.title}
                </h2>
                <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted">{risk.body}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="mt-6 text-xs leading-relaxed text-muted">
          This disclosure summarises risks; it is not an exhaustive list of every risk associated
          with trading, crypto settlement, or third-party providers. It does not constitute legal,
          tax or investment advice. Where the terms of a broker, payment provider or applicable law
          conflict with anything stated here, those terms and laws prevail.
        </p>
      </Section>
    </>
  );
}
