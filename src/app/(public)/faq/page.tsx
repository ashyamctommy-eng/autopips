import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { TARGET_RETURN_DISCLAIMER, TARGET_RETURN_LABEL } from '@/lib/contracts';
import { NonGuaranteedNote } from '@/components/shared/disclaimer';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CtaBand } from '@/components/public/cta-band';

/**
 * FAQ.
 *
 * The accordion is a native <details>/<summary> list: keyboard operable and
 * screen-reader legible without adding a dependency, and every item collapses to
 * a linkable anchor id so other pages can deep-link a single answer.
 *
 * Answers describe implemented behaviour only. Where the honest answer is "this
 * depends on the operator's jurisdiction" or "no, it is not guaranteed", the
 * page says that in plain words.
 */

export const metadata: Metadata = {
  title: 'FAQ',
  description:
    'How deposits credit, why identity review is manual, withdrawal processing, drawdown limits, P/L calculation, security and what happens at maturity.',
  alternates: { canonical: '/faq' },
};

interface FaqItem {
  id: string;
  question: string;
  answer: React.ReactNode;
}

const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: 'deposits',
    question: 'How are deposits credited?',
    answer: (
      <>
        <p>
          You request a deposit and the platform creates a payment with NOWPayments. You are shown a
          unique deposit address belonging to that one payment, together with the amount to send and
          the asset and network. The payment id and address are stored against your deposit record.
        </p>
        <p>
          Your balance is credited only after the provider reports the payment confirmed on chain.
          Broadcasting a transaction is not enough, and an unconfirmed transfer is not spendable.
          Each webhook callback is verified with an HMAC-SHA512 signature over the raw request body
          before anything is written, and replayed callbacks are discarded. If a callback fails
          verification it is rejected and audited without touching your deposit. The current
          minimum deposit is 50 USD-equivalent.
        </p>
      </>
    ),
  },
  {
    id: 'kyc',
    question: 'Why is identity verification manual, and what documents are accepted?',
    answer: (
      <>
        <p>
          Reviews are performed by a human against your uploaded documents; there is no automated
          identity-scoring service in the platform. A reviewer approves, rejects or requests more
          information, and every one of those decisions is written to the audit log.
        </p>
        <p>Accepted documents:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>Identity: passport, national identity card or driving licence (front, and back where the document has one).</li>
          <li>Proof of address (a recent utility bill, bank statement or similar document).</li>
          <li>A selfie, to tie the document to the person submitting it.</li>
        </ul>
        <p>
          Files may be JPEG, PNG, WebP or PDF, up to 10 MB each. You must be at least 18 years old.
          Documents are stored in a private, encrypted bucket and leave it only as short-lived signed
          links minted for the reviewer — and minting one is itself audited.
        </p>
      </>
    ),
  },
  {
    id: 'withdrawals',
    question: 'How are withdrawals processed, and what fees apply?',
    answer: (
      <>
        <p>
          You request a withdrawal to a crypto address on a supported network, and the platform
          validates the address format for that network before accepting it. The request is checked
          against your withdrawable balance, which is derived from the ledger — capital still
          deployed in an active strategy is not withdrawable until it is released.
        </p>
        <p>
          Payouts are broadcast through NOWPayments and an operator reviews each one. Autopipsz
          charges no withdrawal fee today: the fee is recorded as 0.00 on the request so a later fee
          schedule cannot appear retroactive. Network costs set by the blockchain and the payout
          provider still apply and are outside our control. On-chain settlement is not instant, and
          a payout depends on the network being available.
        </p>
      </>
    ),
  },
  {
    id: 'drawdown',
    question: 'What happens if a strategy hits its drawdown limit?',
    answer: (
      <>
        <p>
          Each plan publishes a maximum drawdown. Before every order, the risk gate computes the
          investment&rsquo;s drawdown against the capital deployed and refuses new positions when
          the limit is reached or exceeded. An unevaluable drawdown counts as a breach, not as a
          pass.
        </p>
        <p>
          A breach stops new exposure; it does not restore losses. Positions can also gap past a
          stop level, so a realised loss may be larger than the limit intended. The limit is a
          brake, not protection.
        </p>
      </>
    ),
  },
  {
    id: 'returns',
    question: 'Are returns guaranteed?',
    answer: (
      <>
        <p className="font-medium text-base-100">
          No. Any figure labelled &ldquo;{TARGET_RETURN_LABEL}&rdquo; is a strategy objective, not a
          promise — and no return on this platform is guaranteed.
        </p>
        <p>
          Any percentage shown against a strategy is a target or objective derived from historical
          broker data. It is not a promise, not a projection and not a commitment, and the strategy
          may lose money instead. {TARGET_RETURN_DISCLAIMER}
        </p>
        <p>
          There is no fixed daily, weekly or monthly payout anywhere on Autopipsz, and no product
          here promises the return of your capital. Past performance is not indicative of future
          results.
        </p>
        <NonGuaranteedNote variant="banner" className="mt-2" />
      </>
    ),
  },
  {
    id: 'pnl',
    question: 'How is P/L calculated?',
    answer: (
      <>
        <p>
          Profit and loss comes from broker deals. When a position closes, the platform records the
          broker&rsquo;s own exit price, gross P/L, commission and swap, and the net figure is what
          counts toward your result. Nothing is derived from an entry price or an assumption about
          where the position should have closed.
        </p>
        <p>
          Your account equity is then recomputed from an explicit formula over persisted rows:
        </p>
        <p className="overflow-x-auto rounded-lg border border-line bg-base-900/70 p-3 font-mono text-xs text-base-100">
          Equity = Starting Capital + Realized P/L + Unrealized P/L − Deducted Fees − Withdrawals +
          Confirmed Deposits
        </p>
        <p>
          Capital currently deployed with a strategy and confirmed-but-undeployed cash are two
          disjoint parts of the same total, so moving money from idle cash into a strategy — or back
          out — does not change your equity by itself. Unrealised P/L is marked from the broker&rsquo;s
          reported floating result and can move against you until the position closes.
        </p>
      </>
    ),
  },
  {
    id: 'segregation',
    question: 'Is my capital segregated?',
    answer: (
      <>
        <p>
          Autopipsz does not hold your funds in a bank account of its own and does not claim a
          segregated-custody arrangement. Strategy capital executes on a MetaTrader account held with
          a broker, and that account is subject to the broker&rsquo;s own terms, including how client
          money is held and what happens if the broker fails.
        </p>
        <p>
          Internally, your entitlement is tracked per client in the platform ledger — deployed
          capital, realised P/L, fees and withdrawals are recorded against your user id — and that
          is what your withdrawable balance is computed from. This is an accounting separation, not
          a legal trust, and it is not insured.
        </p>
      </>
    ),
  },
  {
    id: '2fa',
    question: 'Do I need two-factor authentication, and how does it work?',
    answer: (
      <>
        <p>
          Passwords are stored as Argon2id hashes, and the platform supports time-based one-time
          passwords (TOTP) compatible with any standard authenticator application. Enrolment shows a
          provisioning QR code and then a challenge that must be passed before 2FA becomes active.
          A login with 2FA enabled only succeeds after the challenge is verified, and enabling or
          disabling it is written to the audit log.
        </p>
        <p>
          Enable it. Your account holds a withdrawable balance, and a password alone is a single
          point of failure.
        </p>
      </>
    ),
  },
  {
    id: 'data',
    question: 'What data does the platform store about me?',
    answer: (
      <>
        <p>
          Your account record (email, name, country, role, 2FA state), your identity submission
          (legal name, date of birth, address, document type and number, review status), your money
          movements, and the activity generated by your account — investments, trades, positions,
          deposits, withdrawals and audit entries.
        </p>
        <p>
          Identity documents are held in a private bucket, encrypted at rest, and are readable only
          through short-lived signed links issued to a signed-in reviewer. You are never shown
          another client&rsquo;s data, and document access events are logged. Sessions are carried in
          httpOnly cookies — no access token is placed in browser storage.
        </p>
      </>
    ),
  },
  {
    id: 'minimums',
    question: 'What are the minimum amounts?',
    answer: (
      <>
        <p>
          The minimum deposit is 50 USD-equivalent, and a single deposit is capped at 250,000
          USD-equivalent. Each strategy also has its own minimum and maximum allocation, published
          on the{' '}
          <Link href="/plans" className="text-brand-300 underline-offset-4 hover:underline">
            plans page
          </Link>{' '}
          and on its strategy card. An allocation below a plan&rsquo;s minimum, or above its maximum,
          is refused.
        </p>
        <p>
          A withdrawal has no fixed minimum beyond the smallest positive amount, because the real
          ceiling is your withdrawable balance — and that is computed from verified ledger rows
          rather than a portfolio estimate.
        </p>
      </>
    ),
  },
  {
    id: 'pause',
    question: 'Can I pause or stop an investment?',
    answer: (
      <>
        <p>
          Yes. An investment can be paused — no new positions are opened for it — and it can be
          closed. Both transitions are stored as status changes and written to the audit log with
          the actor and the time.
        </p>
        <p>
          Pausing stops new exposure; it does not close positions already open, which continue to
          carry risk until the broker closes them. Closing returns realised capital to your
          withdrawable balance, and unrealised P/L is only settled when the position closes.
        </p>
      </>
    ),
  },
  {
    id: 'maturity',
    question: 'What happens when a plan reaches maturity?',
    answer: (
      <>
        <p>
          Each investment carries a maturity date calculated from the plan&rsquo;s term when it is
          created. At maturity the investment is marked matured and its capital and realised result
          are released to your account, at which point they form part of your withdrawable balance.
        </p>
        <p>
          Maturity is not a payout schedule and not a profit event: the amount you receive is
          whatever the ledger says the investment is worth at that point, which can be less than the
          capital you allocated. Whether the strategy met its target has no effect on the arithmetic —
          only the realised result does.
        </p>
      </>
    ),
  },
  {
    id: 'fees',
    question: 'How and when are fees charged?',
    answer: (
      <>
        <p>
          Two fees exist. A performance fee is charged on profit that takes an investment above its
          high-water mark — the higher of funded capital and the peak value recorded at the previous
          fee event — so a client who is below that mark pays no performance fee, including on the
          way back up. A management fee is charged pro-rata on a 365-day basis over the days the
          capital was actually deployed.
        </p>
        <p>
          Fees are subtracted from the investment and never allowed to drive its value below zero.
          Both percentages are published for each plan, and every applied fee is written to the
          audit log.
        </p>
      </>
    ),
  },
  {
    id: 'execution',
    question: 'Where does my capital actually execute, and which broker?',
    answer: (
      <>
        <p>
          Orders are submitted to MetaTrader 4 / MT5 accounts through MetaApi.cloud, which connects
          to the broker&rsquo;s own trade servers. Autopipsz is not a broker, is not a venue, and
          does not hold a matching engine; the broker executes, and the broker&rsquo;s deal reports
          are the source of every P/L figure shown in your account.
        </p>
        <p>
          That means you carry counterparty and broker risk, not just market risk: the broker&rsquo;s
          solvency, its execution quality, its margin rules and its own terms sit between you and the
          market.
        </p>
      </>
    ),
  },
];

export default function FaqPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'FAQ' }]}
          eyebrow="FAQ"
          title="Questions, answered without hedging"
          description="Fourteen answers about money in, money out, identity review, risk limits, security and what this platform does not promise."
        />
      </div>

      <Section width="default">
        <Alert variant="warn" className="mb-6">
          <AlertTitle>Targets are indicative and non-guaranteed</AlertTitle>
          <AlertDescription>
            No strategy on this platform guarantees a return, and trading can lose you money. Read
            the{' '}
            <Link href="/risk" className="text-brand-300 underline-offset-4 hover:underline">
              risk disclosure
            </Link>{' '}
            as well as these answers.
          </AlertDescription>
        </Alert>

        <nav aria-label="FAQ contents" className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-brand-300">Contents</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {FAQ_ITEMS.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="rounded-sm text-sm text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {item.question}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex flex-col gap-3">
          {FAQ_ITEMS.map((item) => (
            <details
              key={item.id}
              id={item.id}
              className="group scroll-mt-24 rounded-xl border border-line bg-base-850/70 shadow-card open:bg-base-850"
            >
              <summary className="flex cursor-pointer items-start justify-between gap-4 rounded-xl p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
                <h2 className="text-[1rem] font-semibold leading-snug tracking-tight text-base-100">
                  {item.question}
                </h2>
                <span
                  aria-hidden
                  className="mt-1 shrink-0 text-muted transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-line p-5 text-sm leading-relaxed text-muted">
                {item.answer}
              </div>
            </details>
          ))}
        </div>

        <Card className="mt-6">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <h2 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                Still unanswered?
              </h2>
              <p className="text-sm leading-relaxed text-muted">
                Send the question through the contact form — every message is recorded and reviewed.
              </p>
            </div>
            <Button variant="outline" asChild>
              <Link href="/contact">
                Contact the operator
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </Section>

      <Section width="wide" className="pt-0">
        <CtaBand
          title="Ready to look at the numbers yourself?"
          description="Active strategies show their own track record, populated only from closed broker deals."
          primaryHref="/register"
          primaryLabel="Open an account"
          secondaryHref="/strategies"
          secondaryLabel="View strategies"
        />
      </Section>
    </>
  );
}
