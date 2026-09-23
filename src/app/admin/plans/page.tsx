import type { Metadata } from 'next';

import { AdminOnlyNotice } from '@/components/admin/admin-only-notice';
import { PlanConfigurator } from '@/components/admin/plan-configurator';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { requireStaffPage } from '../_lib/admin-data';
import { listPlans } from '@/server/modules/admin/admin.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Trading plans',
  description: 'Capital tiers, fees, drawdown stops and live strategy track records.',
};

/**
 * Trading plans.
 *
 * ADMIN-only: the whole plans API (read included) requires the ADMIN role, so a
 * TRADING_MANAGER is told why the page is empty instead of being shown a form
 * whose requests would be refused.
 *
 * `listPlans()` returns each plan with its live stats — or `stats: null` when the
 * strategy has no closed trades, which the table renders as "no verified track
 * record" rather than a zero.
 */
export default async function AdminPlansPage() {
  const user = await requireStaffPage();

  if (user.role !== 'ADMIN') {
    return (
      <Section width="wide">
        <PageHeader
          eyebrow="Administration"
          breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Plans' }]}
          title="Trading plans"
        />
        <div className="mt-6">
          <AdminOnlyNotice feature="the trading-plan catalogue" />
        </div>
      </Section>
    );
  }

  const plans = await listPlans();

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Administration"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Plans' }]}
        title="Trading plans"
        description="Capital tiers, fees and the drawdown stop the bot engine enforces. Target returns are indicative objectives and are always rendered with their caveat."
      />

      <div className="mt-6">
        <PlanConfigurator initialPlans={plans} canManage />
      </div>
    </Section>
  );
}
