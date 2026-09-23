import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, XCircle } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CtaBand } from '@/components/public/cta-band';

/**
 * About / operating model.
 *
 * Describes the platform as it is built, names the real components in the stack,
 * and states the limits of what Autopipsz is. No licence is claimed, no partner
 * is named and no statistic is asserted.
 */

export const metadata: Metadata = {
  title: 'About',
  description:
    'Autopipsz is managed algorithmic trading infrastructure: a master MT4/MT5 account executes operator-run strategies, mirrored into client-funded investments, with crypto settlement and an append-only audit record.',
  alternates: { canonical: '/about' },
};

interface StackItem {
  name: string;
  role: string;
}

const STACK: readonly StackItem[] = [
  { name: 'Next.js 14 (App Router) + TypeScript', role: 'Server-rendered client area and this public site, with API route handlers for every money path.' },
  { name: 'PostgreSQL + Prisma', role: 'System of record: users, KYC profiles, deposits, withdrawals, investments, trade records and the audit log.' },
  { name: 'Redis', role: 'Rate-limit counters, distributed locks (single-writer bot runtime), replay guards and short-lived credential cache.' },
  { name: 'MetaApi.cloud SDK', role: 'Broker connectivity to MetaTrader 4/5 — account state, candles, order submission and deal history.' },
  { name: 'NOWPayments', role: 'Crypto deposit addresses, payout broadcast and signed IPN callbacks.' },
  { name: 'Argon2id + TOTP (speakeasy)', role: 'Password hashing and time-based two-factor authentication.' },
  { name: 'AWS S3 + KMS', role: 'Private storage for identity documents, encrypted at rest, reachable only through short-lived signed links.' },
  { name: 'Socket.IO service', role: 'Streams broker-sourced position, equity and activity events to signed-in clients.' },
  { name: 'Decimal arithmetic', role: 'All balances, P/L and fees — no floating-point money anywhere in the platform.' },
];

const WHAT_IT_IS: readonly string[] = [
  'A managed trading platform: you allocate capital to a strategy, and a master broker account executes that strategy on MT4/MT5 through MetaApi.cloud.',
  'A record-keeping platform: equity follows a published formula over persisted ledger rows, and every money or identity event is written to an append-only audit log.',
  'A crypto-settlement platform: deposits and payouts move through NOWPayments, and deposits are credited only after on-chain confirmation.',
  'A self-service platform: registration, identity submission, funding, allocation, monitoring and withdrawal all happen in your account, not over email.',
];

const WHAT_IT_IS_NOT: readonly string[] = [
  'Not a bank, a broker or a deposit-taker. Autopipsz is not a bank, is not a custodian, and no account here is a bank deposit.',
  'Not insured or capital-protected. There is no deposit insurance, no guarantee scheme and no compensation fund behind your balance.',
  'Not a guaranteed-return product. No plan promises a fixed profit, a fixed daily payout or the return of capital. Targets are objectives.',
  'Not investment advice. Nothing published here is a personal recommendation; decisions are yours and the operator’s regulatory status must be confirmed for your jurisdiction.',
  'Not a licence holder by implication. Autopipsz does not claim any licence or regulatory authorisation on this site, and where a licence is required for you to be served, that must be established with the operator before you fund an account.',
];

export default function AboutPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'About' }]}
          eyebrow="About"
          title="Automated trading infrastructure, operated honestly"
          description="Autopipsz connects client capital to algorithmic execution on MetaTrader 4 and MT5 accounts. The proposition is narrow and deliberate: real broker execution, real settlement, and a record that shows exactly what happened."
        />
      </div>

      <Section
        width="wide"
        eyebrow="Mission"
        title="Why the platform exists"
        description="Most retail trading products fail at the same place: you hand over money, and afterwards you cannot verify what was done with it."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardContent className="flex flex-col gap-4 p-5 text-sm leading-relaxed text-muted">
              <p>
                Autopipsz exists to close that gap. Capital is deployed into a strategy that runs on
                a real broker account, and every position is tagged so it can be traced back to the
                investment that funded it. Profit and loss are read from broker deals — commission
                and swap included — rather than derived from a model of what should have happened.
              </p>
              <p>
                That constraint shapes the whole build: the platform would rather show an empty
                track record than a flattering one, and rather refuse an allocation than approximate
                it. Where a figure cannot be proved from a broker deal, a verified payment callback
                or a recorded administrative action, it is not displayed.
              </p>
              <p>
                Settlement is deliberately crypto-first. A payment gets a unique address, a signed
                webhook and an on-chain confirmation before it counts. Payouts are broadcast through
                the same provider, and both directions are audited.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 p-5 text-sm leading-relaxed text-muted">
              <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                Operating model in one paragraph
              </h3>
              <p>
                An operator configures a strategy — symbols, timeframe, indicator periods and master
                lot size. The strategy runs against broker candles. When it signals, the master
                account takes the position, and each client investment is mirrored a proportional
                slice of it. P/L flows back per investment from the broker&apos;s own deal events.
              </p>
              <p>
                Clients pay a performance fee on new profit above a high-water mark and a
                pro-rata management fee on capital deployed. Nothing else is deducted.
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section
        width="wide"
        eyebrow="Technology"
        title="The stack behind the numbers"
        description="Named plainly, because 'proprietary technology' is not an explanation."
      >
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STACK.map((item) => (
            <li
              key={item.name}
              className="flex flex-col gap-1.5 rounded-xl border border-line bg-base-850/70 p-4 shadow-card"
            >
              <h3 className="text-sm font-medium text-base-100">{item.name}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.role}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        width="wide"
        eyebrow="Boundaries"
        title="What Autopipsz is, and what it is not"
        description="Stated explicitly, because the difference matters before you fund an account."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                This platform is
              </h3>
              <ul className="flex flex-col gap-3">
                {WHAT_IT_IS.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted">
                    <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-profit-400" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                This platform is not
              </h3>
              <ul className="flex flex-col gap-3">
                {WHAT_IT_IS_NOT.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted">
                    <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-loss-400" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/risk">
              Risk disclosure
              <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/contact">Contact the operator</Link>
          </Button>
        </div>
      </Section>

      <Section width="wide" className="pt-0">
        <CtaBand
          title="See the mechanics before the marketing"
          description="The transparency section on the home page walks through settlement, broker execution and record integrity step by step."
          primaryHref="/register"
          primaryLabel="Open an account"
          secondaryHref="/strategies"
          secondaryLabel="Read the strategy mechanics"
        />
      </Section>
    </>
  );
}
