import { Layers, Wallet } from 'lucide-react';

import { PlanAllocator } from '@/components/dashboard/plan-allocator';
import { MetricTile } from '@/components/shared/metric-tile';
import { Usd } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/ui/empty-state';
import { getOverview, listActivePlans, listInvestments } from '@/lib/services/account.service';
import { requireSessionUser } from '@/lib/services/session';
import type { InvestmentDTO } from '@/types/api';

/**
 * Client plan picker + capital deployment (server component).
 *
 * This page was missing: the API exposed `GET /api/v1/plans` and
 * `POST /api/v1/account/investments`, the admin console could start an
 * investment on a client's behalf, and the overview rendered existing
 * investments — but a client had no surface of their own to browse the active
 * plans and deploy their idle cash into one. This is that surface.
 *
 * Every figure comes from the account service (`getOverview`, `listActivePlans`,
 * `listInvestments`); nothing here is computed or assumed.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardPlansPage() {
  const user = await requireSessionUser();

  const [plans, overview, investments] = await Promise.all([
    listActivePlans(),
    getOverview(user.id),
    listInvestments(user.id),
  ]);

  const availableUsd = Math.max(0, overview.withdrawableBalance);
  const openInvestments: InvestmentDTO[] = investments.filter(
    (investment) => investment.status === 'ACTIVE' || investment.status === 'PAUSED',
  );
  const deployedUsd = openInvestments.reduce(
    (total, investment) => total + investment.capitalUsd,
    0,
  );

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Managed strategies"
        title="Investment plans"
        description="Allocate idle cash into a strategy to start bot trading. Capital is deployed from your withdrawable balance, and the plan's own minimum and maximum apply."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Plans' }]}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricTile
          label="Available to deploy"
          value={<Usd value={availableUsd} tone="neutral" />}
          sub="Idle cash not yet in a strategy"
          icon={Wallet}
        />
        <MetricTile
          label="Capital deployed"
          value={<Usd value={deployedUsd} tone="neutral" />}
          sub={`${openInvestments.length} active ${
            openInvestments.length === 1 ? 'strategy' : 'strategies'
          }`}
          icon={Layers}
        />
        <MetricTile
          label="Plans open"
          value={plans.length}
          sub="Strategies accepting capital"
          icon={Layers}
        />
      </div>

      {plans.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={Layers}
            title="No plans are open right now"
            description="Plans published by the operator appear here. When one is active you can deploy part of your balance into it and bot trading starts from that capital."
          />
        </div>
      ) : (
        <PlanAllocator plans={plans} availableUsd={availableUsd} investments={investments} />
      )}
    </Section>
  );
}
