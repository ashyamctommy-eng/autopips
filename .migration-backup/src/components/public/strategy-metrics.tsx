'use client';

import * as React from 'react';
import Link from 'next/link';
import { BarChart3, ShieldAlert } from 'lucide-react';

import { formatPercent } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { StrategyStats, TradingPlanDTO } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { NonGuaranteedNote, TargetRange } from '@/components/shared/disclaimer';
import { Pct, Usd } from '@/components/shared/money';
import { RiskBadge } from '@/components/shared/risk-badge';

/**
 * Live strategy cards.
 *
 * Client component because the visitor filters the list; the DATA itself is
 * fetched by the server page and passed down as props, so nothing here calls an
 * API or reads a credential.
 *
 * ZERO-FABRICATION RULES this component is responsible for honouring:
 *   • A target range is rendered ONLY through <TargetRange />, which cannot be
 *     made to drop the non-guarantee label.
 *   • `stats === null` (or zero closed trades) renders an explicit "no verified
 *     track record" state. No substituted win rate, no "typical" return and no
 *     illustrative equity curve.
 *   • Every figure in the track-record block comes from `stats`, which the
 *     server derives from closed TradeRecord rows written from broker deals.
 */

const RISK_FILTERS = ['ALL', 'LOW', 'MEDIUM', 'HIGH'] as const;
type RiskFilter = (typeof RISK_FILTERS)[number];

const RISK_FILTER_LABEL: Record<RiskFilter, string> = {
  ALL: 'All risk levels',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

export interface StrategyMetricsProps {
  plans: TradingPlanDTO[];
  className?: string;
}

export function StrategyMetrics({ plans, className }: StrategyMetricsProps) {
  const [riskFilter, setRiskFilter] = React.useState<RiskFilter>('ALL');
  const [query, setQuery] = React.useState('');

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return plans.filter((plan) => {
      const riskOk = riskFilter === 'ALL' || plan.riskLevel.toUpperCase() === riskFilter;
      if (!riskOk) return false;
      if (needle === '') return true;
      return (
        plan.name.toLowerCase().includes(needle) || plan.description.toLowerCase().includes(needle)
      );
    });
  }, [plans, riskFilter, query]);

  const searchId = 'strategy-search';

  if (plans.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        size="lg"
        title="No strategies are currently open for allocation"
        description="Every strategy shown here comes from the platform's own records, so there is nothing to display until an operator publishes an active plan. No sample card, no example figure and no historical stand-in is shown in its place."
        action={
          <Button variant="outline" asChild>
            <Link href="/contact">Ask about upcoming strategies</Link>
          </Button>
        }
        className={cn('surface', className)}
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter strategies by risk level"
        >
          {RISK_FILTERS.map((filter) => {
            const active = riskFilter === filter;
            return (
              <Button
                key={filter}
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                aria-pressed={active}
                onClick={() => setRiskFilter(filter)}
              >
                {RISK_FILTER_LABEL[filter]}
              </Button>
            );
          })}
        </div>

        <div className="flex w-full flex-col gap-1.5 sm:max-w-xs">
          <label
            htmlFor={searchId}
            className="text-xs font-medium uppercase tracking-wide text-muted"
          >
            Search strategies
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <p aria-live="polite" className="text-xs text-muted">
        Showing {visible.length} of {plans.length} active{' '}
        {plans.length === 1 ? 'strategy' : 'strategies'}.
      </p>

      {visible.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No strategy matches this filter"
          description="Nothing was hidden and nothing was substituted — clear the search box or pick a different risk level."
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setQuery('');
                setRiskFilter('ALL');
              }}
            >
              Reset filters
            </Button>
          }
          className="surface"
        />
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2">
          {visible.map((plan) => (
            <li key={plan.id} className="flex">
              <StrategyCard plan={plan} />
            </li>
          ))}
        </ul>
      )}

      <TrackRecordDisclosure />
    </div>
  );
}

function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular-nums text-sm text-base-100">{children}</dd>
    </div>
  );
}

function StrategyCard({ plan }: { plan: TradingPlanDTO }) {
  return (
    <Card className="flex w-full flex-col">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
              {plan.name}
            </h3>
            <p className="text-xs uppercase tracking-wide text-muted">
              {plan.durationDays} day term · {formatPercent(plan.maxDrawdown, 2)} max drawdown limit
            </p>
          </div>
          <RiskBadge level={plan.riskLevel} />
        </div>
        <p className="text-sm leading-relaxed text-muted">{plan.description}</p>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Target range</dt>
            <dd className="text-lg font-semibold">
              <TargetRange min={plan.targetReturnMin} max={plan.targetReturnMax} />
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Investment range
            </dt>
            <dd className="flex flex-wrap items-baseline gap-1 text-sm text-base-100">
              <Usd value={plan.minInvestment} tone="neutral" />
              <span className="text-muted">to</span>
              <Usd value={plan.maxInvestment} tone="neutral" />
            </dd>
          </div>
        </dl>

        <div className="rounded-lg border border-line bg-base-900/60 p-4">
          <dl className="flex flex-col gap-2">
            <DetailLine label="Performance fee (above high-water mark)">
              {formatPercent(plan.performanceFee, 2)}
            </DetailLine>
            <DetailLine label="Management fee (annual, pro-rata)">
              {formatPercent(plan.managementFee, 2)}
            </DetailLine>
          </dl>
        </div>

        <TrackRecord stats={plan.stats} />
      </CardContent>
    </Card>
  );
}

function TrackRecord({ stats }: { stats: StrategyStats | null }) {
  if (stats === null || stats.closedTrades === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-base-900/60 p-4">
        <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-base-100">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn-400" />
          No verified track record yet — this strategy has no closed, broker-confirmed trades.
        </p>
        <p className="text-xs leading-relaxed text-muted">
          Nothing is substituted here: not a sample win rate, not a &ldquo;typical&rdquo; return and
          not an illustrative equity curve. This block fills in once broker deals close against a
          funded investment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-base-900/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <BarChart3 aria-hidden className="size-4 text-brand-400" />
        <h4 className="text-sm font-medium text-base-100">Verified track record</h4>
        <Badge variant="outline" className="ml-auto">
          Closed broker trades only
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Stat
          label="Closed trades"
          value={<span className="tabular-nums">{stats.closedTrades}</span>}
        />
        <Stat
          label="Win rate"
          value={<Pct value={stats.winRatePct} tone="neutral" />}
          hint={
            stats.winRatePct === null
              ? 'Not enough closed trades'
              : `${stats.winningTrades} won · ${stats.losingTrades} lost`
          }
        />
        <Stat
          label="Observed return"
          value={<Pct value={stats.observedReturnPct} sign tone="auto" />}
          hint="Net P/L over capital deployed"
        />
        <Stat
          label="Max observed drawdown"
          value={<Pct value={stats.maxObservedDrawdownPct} tone="neutral" />}
          hint="Largest realised peak-to-trough fall"
        />
      </dl>

      <dl className="border-t border-line pt-3">
        <DetailLine label="Realised net P/L">
          <Usd value={stats.netPnL} sign tone="auto" />
        </DetailLine>
      </dl>

      <p className="text-xs leading-relaxed text-muted">
        Aggregated from {stats.closedTrades} closed deal{stats.closedTrades === 1 ? '' : 's'}
        {stats.firstTradeAt ? ` between ${formatDay(stats.firstTradeAt)}` : ''}
        {stats.lastTradeAt ? ` and ${formatDay(stats.lastTradeAt)}` : ''}. Past results are not
        indicative of future results.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold text-base-100">{value}</dd>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function TrackRecordDisclosure() {
  return (
    <details className="rounded-lg border border-line bg-base-850/60 p-4 text-sm text-muted">
      <summary className="cursor-pointer rounded-sm text-sm font-medium text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
        How these numbers are produced
      </summary>
      <div className="mt-3 flex flex-col gap-3 leading-relaxed">
        <p>
          Every figure in a track-record block is computed from closed broker records written
          back from the broker, joined to the capital the investment had deployed at the time. A
          trade enters the record only when the broker reports the position closed, carrying the
          broker&rsquo;s own exit price, P/L, commission and swap.
        </p>
        <p>
          <span className="text-base-100">Closed trades</span> counts those records.{' '}
          <span className="text-base-100">Win rate</span> is winning closed trades divided by closed
          trades. <span className="text-base-100">Observed return</span> is realised net P/L divided
          by the capital deployed to this strategy.{' '}
          <span className="text-base-100">Max observed drawdown</span> is the largest
          peak-to-trough fall in realised equity across that history.
        </p>
        <p>
          A strategy with no closed trades shows nothing rather than a zero or an estimate, and no
          figure is annualised or projected forward.
        </p>
        <NonGuaranteedNote variant="footnote" />
      </div>
    </details>
  );
}

/** `2026-03-04T10:00:00.000Z` → `4 Mar 2026` (UTC, so server and client agree). */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
