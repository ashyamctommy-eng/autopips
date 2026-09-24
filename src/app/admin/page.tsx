import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ArrowUpFromLine,
  Banknote,
  CircleDollarSign,
  Coins,
  Gauge,
  Layers,
  Percent,
  Plug,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ActivityFeed } from '@/components/shared/activity-feed';
import { LiveDot, type LiveDotState } from '@/components/shared/live-dot';
import { MetricTile } from '@/components/shared/metric-tile';
import { Pct, SignedUsd, Usd } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatCard } from '@/components/shared/stat-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { NonGuaranteedNote } from '@/components/shared/disclaimer';
import { LatencyProbeCell } from '@/components/admin/latency-probe';
import { requireStaffPage } from './_lib/admin-data';
import { getAdminOverview } from '@/server/modules/admin/admin.service';
import { EQUITY_FORMULA } from '@/server/accounting/equity';
import { D, usd } from '@/lib/money';
import { relativeTime } from '@/lib/utils';
import type { BrokerConnectionDTO } from '@/types/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'AUM dashboard',
  description: 'Platform capital, equity, exposure and settlement position — every figure ledger-derived.',
};

function liveStateFor(status: string): LiveDotState {
  switch (status.toUpperCase()) {
    case 'CONNECTED':
    case 'DEPLOYED':
      return 'connected';
    case 'CONNECTING':
      return 'connecting';
    case 'ERROR':
      return 'error';
    case 'DISCONNECTED':
    case 'UNDEPLOYED':
      return 'disconnected';
    default:
      return 'paused';
  }
}

function environmentVariant(environment: string): 'danger' | 'brand' {
  return environment.toUpperCase() === 'LIVE' ? 'danger' : 'brand';
}

function BrokerSummaryRow({ connection }: { connection: BrokerConnectionDTO }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line/60 px-5 py-4 last:border-b-0 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-base-100">{connection.brokerName}</span>
          <Badge variant={environmentVariant(connection.environment)}>{connection.environment}</Badge>
          <StatusBadge status={connection.status} kind="broker" showIcon />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span className="font-mono">{connection.maskedAccount}</span>
          <LiveDot state={liveStateFor(connection.status)} size="sm" />
          <span suppressHydrationWarning>updated {relativeTime(connection.updatedAt)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:min-w-[34rem]">
        <div className="flex flex-col">
          <span className="text-[0.68rem] uppercase tracking-wide text-muted">Balance</span>
          <Usd value={connection.balance} tone="neutral" className="text-sm" />
        </div>
        <div className="flex flex-col">
          <span className="text-[0.68rem] uppercase tracking-wide text-muted">Equity</span>
          <Usd value={connection.equity} tone="neutral" className="text-sm" />
        </div>
        <div className="flex flex-col">
          <span className="text-[0.68rem] uppercase tracking-wide text-muted">Free margin</span>
          <Usd value={connection.freeMargin} tone="neutral" className="text-sm" />
        </div>
        <div className="flex flex-col">
          <span className="text-[0.68rem] uppercase tracking-wide text-muted">Latency</span>
          <LatencyProbeCell
            connectionId={connection.id}
            initialLatencyMs={connection.latencyMs}
            brokerName={connection.brokerName}
            className="pt-0.5"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * AUM dashboard.
 *
 * One service call (`getAdminOverview`) backs the whole screen: AUM summary,
 * activity feed, broker list (un-probed) and platform trading stats. Every money
 * figure on this page is a projection of `server/accounting/**` — the page itself
 * performs no ledger arithmetic except rendering the equity identity back to the
 * operator so a drift would be visible here rather than hidden in a chart.
 */
export default async function AdminDashboardPage() {
  await requireStaffPage();
  const overview = await getAdminOverview();
  const { aum } = overview;
  const breakdown = aum.platformBreakdown;

  // ── The ledger identity, reproduced from its own terms ────────────────────
  // These are the exact inputs `getPlatformLedger()` feeds `computeEquity()`:
  // deployed capital (ACTIVE/PAUSED investments), unallocated cash
  // (confirmed deposits − withdrawals paid − deployed, floored at zero), realised
  // P/L, broker-sourced unrealised P/L, fees deducted and money actually paid out.
  const deployed = D(aum.totalManagedCapital);
  const grossCreditedDeposits = D(breakdown.confirmedDeposits);
  const withdrawalsPaid = D(breakdown.withdrawalsPaid);
  const realizedPnL = D(breakdown.realizedPnL);
  const unrealizedPnL = D(breakdown.unrealizedPnL);
  const deductedFees = D(breakdown.deductedFees);
  const netContributed = usd(grossCreditedDeposits.minus(withdrawalsPaid));
  const unallocatedRaw = netContributed.minus(deployed);
  const unallocatedCash = unallocatedRaw.lessThan(0) ? D(0) : usd(unallocatedRaw);
  const derivedEquity = usd(
    deployed
      .plus(unallocatedCash)
      .plus(realizedPnL)
      .plus(unrealizedPnL)
      .minus(deductedFees)
      .minus(withdrawalsPaid),
  );
  const equityDelta = derivedEquity.minus(D(aum.totalEquity)).abs();
  const identityTies = equityDelta.lessThan(0.01);

  const tradingStats = overview.tradingStats;

  return (
    <>
      <Section width="wide" className="pb-0 pt-6">
        <PageHeader
          eyebrow="Admin console"
          breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'AUM dashboard' }]}
          title="Assets under management"
          description="Platform capital, client equity, open market exposure and today's realised P/L. Every figure is derived from persisted ledger rows — Investment, TradeRecord, Deposit and Withdrawal."
          actions={
            <>
              {aum.pendingKycCount > 0 ? (
                <Button asChild variant="primary">
                  <Link href="/admin/kyc">
                    <ShieldCheck aria-hidden />
                    Review {aum.pendingKycCount} KYC {aum.pendingKycCount === 1 ? 'file' : 'files'}
                  </Link>
                </Button>
              ) : (
                <Button asChild variant="secondary">
                  <Link href="/admin/kyc">
                    <ShieldCheck aria-hidden />
                    KYC queue
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link href="/admin/logs">
                  <ScrollText aria-hidden />
                  Audit log
                </Link>
              </Button>
            </>
          }
        />
      </Section>

      {/* Headline row */}
      <Section width="wide" className="py-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Total managed capital"
            icon={Coins}
            value={<Usd value={aum.totalManagedCapital} tone="neutral" />}
            footer="Capital currently deployed with a strategy (ACTIVE + PAUSED investments)."
          />
          <StatCard
            label="Platform equity"
            icon={Wallet}
            value={<Usd value={aum.totalEquity} tone="neutral" />}
            footer="Sum of every client's equity — not re-derived from summed inputs."
          />
          <StatCard
            label="Open market exposure"
            icon={TrendingUp}
            value={<Usd value={aum.openMarketExposure} tone="neutral" />}
            footer={`Notional of ${aum.openPositions} open position${aum.openPositions === 1 ? '' : 's'} (Σ volume × entry price).`}
          />
          <StatCard
            label="Net today P/L"
            icon={Gauge}
            value={<SignedUsd value={aum.netTodayPnL} />}
            footer="Realised P/L booked by CLOSED trades since 00:00 UTC."
          />
        </div>

        {/* Secondary tiles */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Pending KYC"
            icon={ShieldCheck}
            value={
              <Link href="/admin/kyc" className="text-brand-300 underline-offset-4 hover:underline">
                {aum.pendingKycCount}
              </Link>
            }
            sub="Files awaiting review (PENDING + UNDER_REVIEW)"
          />
          <MetricTile
            label="Active clients"
            icon={Users}
            value={aum.activeClients}
            sub="CLIENT accounts with an approved KYC"
          />
          <MetricTile
            label="Open investments"
            icon={Layers}
            value={aum.openInvestments}
            sub="ACTIVE + PAUSED, holding deployed capital"
          />
          <MetricTile
            label="Realised P/L"
            icon={TrendingUp}
            value={<SignedUsd value={breakdown.realizedPnL} className="text-lg" />}
            sub="Σ CLOSED TradeRecord.netPnL"
          />
          <MetricTile
            label="Unrealised P/L"
            icon={Activity}
            value={<SignedUsd value={breakdown.unrealizedPnL} className="text-lg" />}
            sub="Broker-sourced open positions"
          />
          <MetricTile
            label="Fees collected"
            icon={Percent}
            value={<Usd value={breakdown.deductedFees} tone="neutral" className="text-lg" />}
            sub="Management + performance fees actually deducted"
          />
          <MetricTile
            label="Withdrawals paid"
            icon={ArrowUpFromLine}
            value={<Usd value={breakdown.withdrawalsPaid} tone="neutral" className="text-lg" />}
            sub="Σ FINISHED withdrawals"
          />
          <MetricTile
            label="Confirmed deposits"
            icon={Banknote}
            value={<Usd value={breakdown.confirmedDeposits} tone="neutral" className="text-lg" />}
            sub="Gross credited deposits (CONFIRMED + FINISHED)"
          />
        </div>
      </Section>

      {/* Accounting integrity + activity */}
      <Section width="wide" className="pb-6 pt-0">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CircleDollarSign aria-hidden className="size-4 text-brand-400" />
                Accounting integrity
              </CardTitle>
              <CardDescription>
                The platform&apos;s equity identity, shown term by term. Every figure below is read
                from persisted ledger rows and produced by{' '}
                <code className="font-mono text-xs text-brand-300">server/accounting/**</code>; the
                admin API adds no arithmetic of its own.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <pre className="overflow-x-auto rounded-lg border border-line bg-base-900/70 p-3 font-mono text-[0.7rem] leading-relaxed text-muted">
                {EQUITY_FORMULA}
              </pre>

              <dl className="flex flex-col divide-y divide-line/60 text-sm">
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Deployed capital</span>
                    <span className="text-xs text-muted">
                      Σ Investment.capitalUsd (ACTIVE + PAUSED)
                    </span>
                  </dt>
                  <dd>
                    <Usd value={deployed.toFixed(2)} tone="neutral" />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Unallocated cash</span>
                    <span className="text-xs text-muted">
                      net contributed capital − deployed capital, floored at 0, where net contributed
                      capital = confirmed deposits − withdrawals paid. Derived exactly as{' '}
                      <code className="font-mono">getPlatformLedger()</code> derives it (idle money not
                      yet deployed).
                    </span>
                  </dt>
                  <dd>
                    <Usd value={unallocatedCash.toFixed(2)} tone="neutral" />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Realised P/L</span>
                    <span className="text-xs text-muted">Σ CLOSED TradeRecord.netPnL</span>
                  </dt>
                  <dd>
                    <SignedUsd value={realizedPnL.toFixed(2)} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Unrealised P/L</span>
                    <span className="text-xs text-muted">
                      Σ Investment.unrealizedPnL (written from broker positions only)
                    </span>
                  </dt>
                  <dd>
                    <SignedUsd value={unrealizedPnL.toFixed(2)} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Fees deducted</span>
                    <span className="text-xs text-muted">Σ Investment.feesDeducted</span>
                  </dt>
                  <dd>
                    <Usd value={`-${deductedFees.toFixed(2)}`} tone="neutral" />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="flex flex-col">
                    <span className="text-base-100">Withdrawals paid</span>
                    <span className="text-xs text-muted">Σ Withdrawal.amountUsd (FINISHED only)</span>
                  </dt>
                  <dd>
                    <Usd value={`-${withdrawalsPaid.toFixed(2)}`} tone="neutral" />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-3">
                  <dt className="text-base-100 font-medium">= Platform equity</dt>
                  <dd>
                    <Usd
                      value={derivedEquity.toFixed(2)}
                      tone="neutral"
                      className="text-[1rem] font-semibold"
                    />
                  </dd>
                </div>
              </dl>

              <Separator />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-base-100">Reported platform equity</span>
                  <span className="text-xs text-muted">
                    <code className="font-mono">getPlatformLedger().totalEquity</code> — the value
                    every other admin surface reads.
                  </span>
                </div>
                <Usd value={aum.totalEquity} tone="neutral" />
              </div>

              <Alert variant={identityTies ? 'success' : 'danger'}>
                <AlertTitle>
                  {identityTies
                    ? 'Projection reconciles with the reported equity'
                    : `Projection differs from the reported equity by ${equityDelta.toFixed(2)} USD`}
                </AlertTitle>
                <AlertDescription>
                  {identityTies
                    ? 'The terms above sum exactly to the value every other admin surface reads, so this screen is the ledger projected rather than a second, independently computed ledger.'
                    : 'The terms above do not reconcile with the reported equity. Treat every figure on this screen as unverified until the ledger is reconciled.'}
                </AlertDescription>
              </Alert>

              <p className="text-xs leading-relaxed text-muted">
                What this check proves: the projection uses the ledger&apos;s inputs and arithmetic, so a
                tie means the dashboard cannot drift from the ledger. What it does not prove: that the
                ledger&apos;s own definition of unallocated cash or the way withdrawals enter the formula is
                correct. The open accounting-review items are recorded in{' '}
                <code className="font-mono">tests/LEDGER-VERIFIER-FINDINGS.md</code> — read that before
                treating any balance on this screen as a settled number.
              </p>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <ActivityFeed
              items={overview.recentActivity}
              title="Recent platform activity"
              description="Newest audit events across trading, KYC, payments and administration."
              max={12}
              listClassName="max-h-[26rem]"
            />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Gauge aria-hidden className="size-4 text-brand-400" />
                  Verified trading history
                </CardTitle>
                <CardDescription>
                  Aggregated from CLOSED trade records only — never projected.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {tradingStats === null ? (
                  <p className="text-sm leading-relaxed text-muted">
                    No closed trades have been booked on this platform yet, so there is no win rate,
                    no observed return and no drawdown to report. Nothing is estimated.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex flex-col">
                        <span className="text-[0.68rem] uppercase tracking-wide text-muted">
                          Closed trades
                        </span>
                        <span className="tabular-nums text-base-100">
                          {tradingStats.closedTrades}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[0.68rem] uppercase tracking-wide text-muted">
                          Win rate
                        </span>
                        {tradingStats.winRatePct === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <Pct value={tradingStats.winRatePct} tone="neutral" />
                        )}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[0.68rem] uppercase tracking-wide text-muted">
                          Net realised P/L
                        </span>
                        <SignedUsd value={tradingStats.netPnL} />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[0.68rem] uppercase tracking-wide text-muted">
                          Active strategies
                        </span>
                        <span className="tabular-nums text-base-100">
                          {tradingStats.activeStrategies}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 text-xs text-muted">
                      <span>
                        Instruments:{' '}
                        {tradingStats.instruments.length === 0
                          ? '—'
                          : tradingStats.instruments.join(', ')}
                      </span>
                      {tradingStats.firstTradeAt ? (
                        <span suppressHydrationWarning>
                          First closed trade {relativeTime(tradingStats.firstTradeAt)}
                        </span>
                      ) : null}
                      {tradingStats.lastTradeAt ? (
                        <span suppressHydrationWarning>
                          Latest closed trade {relativeTime(tradingStats.lastTradeAt)}
                        </span>
                      ) : null}
                    </div>
                    <NonGuaranteedNote variant="footnote" />
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </Section>

      {/* Broker connections */}
      <Section width="wide" className="pb-10 pt-0">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <CardTitle className="flex items-center gap-2">
                <Plug aria-hidden className="size-4 text-brand-400" />
                Broker connections
              </CardTitle>
              <CardDescription>
                Snapshot as stored from the last broker-reported state. Latency is measured only when
                a probe is requested — <span className="text-base-100">—</span> means “not probed”,
                never an invented number.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/brokers">
                <RefreshCw aria-hidden />
                Manage connections
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {overview.brokers.length === 0 ? (
              <p className="px-5 pb-5 text-sm leading-relaxed text-muted">
                No broker connection is registered, so no broker balance, equity or exposure figure
                exists to report. Add a connection from{' '}
                <Link href="/admin/brokers" className="text-brand-300 underline-offset-4 hover:underline">
                  Broker connections
                </Link>
                .
              </p>
            ) : (
              <div className="flex flex-col">
                {overview.brokers.map((connection) => (
                  <BrokerSummaryRow key={connection.id} connection={connection} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
