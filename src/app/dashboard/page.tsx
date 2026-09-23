import Link from 'next/link';
import { ArrowDownToLine, ArrowUpFromLine, Layers, Wallet } from 'lucide-react';

import { ActivityFeed } from '@/components/shared/activity-feed';
import { MetricTile } from '@/components/shared/metric-tile';
import { NonGuaranteedNote, TargetRange } from '@/components/shared/disclaimer';
import { PageHeader } from '@/components/shared/page-header';
import { RiskBadge } from '@/components/shared/risk-badge';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Pct, SignedUsd, Usd } from '@/components/shared/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { getOverview, listActivity, listInvestments } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import type { InvestmentDTO } from '@/types/api';

/**
 * Client overview (server component).
 *
 * Every figure comes from `getOverview()` — the single place the equity formula
 * is applied to persisted ledger rows — or from `listInvestments()` /
 * `listActivity()`. This page computes no money of its own and has no fallback
 * value for a field the API did not return.
 */

export const dynamic = 'force-dynamic';

const ACTIVITY_TAKE = 8;

/** Short, unambiguous date. Returns an em dash for a value the API left null. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface BreakdownRowProps {
  label: string;
  hint?: string;
  /** Arithmetic operator rendered before the value. */
  operator: '+' | '−' | '=';
  value: React.ReactNode;
}

/**
 * One term of the equity formula. The operator is rendered explicitly so the
 * panel reads as the formula rather than as a list of unrelated balances.
 */
function BreakdownRow({ label, hint, operator, value }: BreakdownRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="w-3 shrink-0 text-center font-mono text-sm text-muted">
          {operator}
        </span>
        <div className="min-w-0">
          <p className="text-sm leading-tight text-base-100">{label}</p>
          {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p> : null}
        </div>
      </div>
      <div className="shrink-0 text-right text-sm">{value}</div>
    </div>
  );
}

function InvestmentCard({ investment }: { investment: InvestmentDTO }) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm">{investment.planName}</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Opened {formatDate(investment.startDate ?? investment.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge status={investment.status} kind="investment" showIcon />
          <RiskBadge level={investment.riskLevel} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-5 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wide text-muted">Capital</span>
            <Usd value={investment.capitalUsd} tone="neutral" className="text-sm" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wide text-muted">Current value</span>
            <Usd value={investment.currentValUsd} tone="neutral" className="text-sm" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wide text-muted">Realized P/L</span>
            <SignedUsd value={investment.realizedPnL} className="text-sm" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wide text-muted">Unrealized P/L</span>
            <SignedUsd value={investment.unrealizedPnL} className="text-sm" />
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">Maturity</span>
            <span className="text-sm tabular-nums text-base-100">
              {formatDate(investment.maturityDate)}
            </span>
          </div>
          <TargetRange
            min={investment.targetReturnMin}
            max={investment.targetReturnMax}
            className="items-end text-right"
            valueClassName="text-sm"
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default async function DashboardOverviewPage() {
  const user = await requireSessionUser();

  const [overview, investments, activity] = await Promise.all([
    getOverview(user.id),
    listInvestments(user.id),
    listActivity(user.id, ACTIVITY_TAKE),
  ]);

  const openInvestments = investments.filter(
    (investment) => investment.status === 'ACTIVE' || investment.status === 'PAUSED',
  );
  const { breakdown } = overview;

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow={user.kycStatus === 'APPROVED' ? 'Verified account' : 'Verification pending'}
        title="Account overview"
        description="Every figure below is computed from persisted ledger rows and broker-reported trades — nothing on this page is projected, sampled or estimated."
        breadcrumb={[{ label: 'Dashboard' }]}
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <Link href="/dashboard/deposits">
                <ArrowDownToLine aria-hidden />
                Deposit
              </Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/dashboard/withdrawals">
                <ArrowUpFromLine aria-hidden />
                Withdraw
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Total account value"
          value={<Usd value={overview.equity} tone="neutral" />}
          sub="Equity per the ledger"
          icon={Wallet}
        />
        <MetricTile
          label="Realized P/L"
          value={<SignedUsd value={breakdown.realizedPnL} />}
          sub="Closed trades"
          icon={Layers}
        />
        <MetricTile
          label="Unrealized P/L"
          value={<SignedUsd value={breakdown.unrealizedPnL} />}
          sub="Broker-reported, open positions"
        />
        <MetricTile
          label="Net return"
          value={<Pct value={overview.netReturnPct} sign />}
          sub="Measured against contributed capital"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="p-5 pb-2">
            <CardTitle>Equity breakdown</CardTitle>
            <p className="text-xs leading-relaxed text-muted">
              How the total account value is assembled from your ledger.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col p-5 pt-2">
            <BreakdownRow
              operator="+"
              label="Deployed capital"
              hint="Capital currently allocated to a strategy (active and paused investments)."
              value={<Usd value={breakdown.startingCapital} tone="neutral" />}
            />
            <BreakdownRow
              operator="+"
              label="Realized P/L"
              hint="Sum of the broker's closed-trade results."
              value={<SignedUsd value={breakdown.realizedPnL} />}
            />
            <BreakdownRow
              operator="+"
              label="Unrealized P/L"
              hint="Open-position P/L as reported by the broker."
              value={<SignedUsd value={breakdown.unrealizedPnL} />}
            />
            <BreakdownRow
              operator="−"
              label="Deducted fees"
              hint="Management and performance fees actually taken."
              value={
                <span className="inline-flex items-center gap-1">
                  <span className="text-muted">−</span>
                  <Usd value={breakdown.deductedFees} tone="neutral" />
                </span>
              }
            />
            <BreakdownRow
              operator="−"
              label="Withdrawals"
              hint="Withdrawals already paid out (FINISHED)."
              value={
                <span className="inline-flex items-center gap-1">
                  <span className="text-muted">−</span>
                  <Usd value={breakdown.withdrawals} tone="neutral" />
                </span>
              }
            />
            <BreakdownRow
              operator="+"
              label="Idle cash"
              hint="Confirmed deposits not yet deployed into a strategy."
              value={<Usd value={breakdown.confirmedDeposits} tone="neutral" />}
            />

            <Separator className="my-2" />

            <BreakdownRow
              operator="="
              label="Total account value"
              value={<Usd value={overview.equity} tone="neutral" className="font-semibold" />}
            />

            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-base-900/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-muted">
                  Net contributed capital
                </span>
                <Usd value={breakdown.netContributedCapital} tone="neutral" className="text-sm" />
              </div>
              <p className="text-xs leading-relaxed text-muted">
                Confirmed deposits minus paid withdrawals. Deployed capital and idle cash are a
                partition of this figure, which is why they are never added together twice.
              </p>
              <code className="break-words font-mono text-[0.7rem] leading-relaxed text-muted">
                {overview.formula}
              </code>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <NonGuaranteedNote variant="footnote" />
              <p className="text-xs italic leading-relaxed text-muted">{overview.disclaimer}</p>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="p-5 pb-2">
              <CardTitle>Withdrawable now</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 p-5 pt-2">
              <div className="text-2xl font-semibold tracking-tight text-base-100">
                <Usd value={overview.withdrawableBalance} tone="neutral" />
              </div>
              <p className="text-xs leading-relaxed text-muted">
                Equity minus capital deployed in active strategies and minus withdrawals already in
                flight. Capital in a strategy is released when the strategy closes its positions.
              </p>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted">Pending withdrawals</span>
                <Usd value={overview.pendingWithdrawals} tone="neutral" />
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted">Deposits credited (lifetime)</span>
                <Usd value={breakdown.totalCreditedDeposits} tone="neutral" />
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted">Withdrawals paid (lifetime)</span>
                <Usd value={breakdown.totalPaidWithdrawals} tone="neutral" />
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button asChild variant="primary" size="sm">
                  <Link href="/dashboard/withdrawals">Request withdrawal</Link>
                </Button>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/dashboard/deposits">Add funds</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <ActivityFeed
            items={activity}
            title="Recent account activity"
            description="Your audit trail, newest first."
            listClassName="max-h-72"
            emptyState={
              <EmptyState
                size="sm"
                title="No activity yet"
                description="Trade, settlement and identity events appear here as soon as they are recorded."
              />
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
              Active investments
            </h2>
            <p className="mt-1 text-sm text-muted">
              Capital deployed with a strategy, with broker-sourced P/L.
            </p>
          </div>
          {investments.length > openInvestments.length ? (
            <span className="text-xs text-muted">
              {investments.length - openInvestments.length} closed or matured
            </span>
          ) : null}
        </div>

        {openInvestments.length === 0 ? (
          <div className="rounded-xl border border-line bg-base-850/60">
            <EmptyState
              icon={Layers}
              title="No active investments yet"
              description="Once capital is deployed into a plan it appears here with its live broker P/L and indicative target range. Deposits land as idle cash first and are not traded until they are allocated."
              action={
                <Button asChild variant="primary" size="sm">
                  <Link href="/dashboard/deposits">Deposit funds</Link>
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {openInvestments.map((investment) => (
              <InvestmentCard key={investment.id} investment={investment} />
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
