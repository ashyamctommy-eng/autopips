import Link from '@/lib/next/link';
import { Layers } from 'lucide-react';

import { StrategyTracker } from '@/components/dashboard/strategy-tracker';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { getInvestmentForUser, listInvestments } from '@/lib/services/account.service';
import { requireSessionUser } from '@/lib/services/session';

/**
 * Client → Active strategy tracker (server component).
 *
 * Loads every ACTIVE/PAUSED investment with the book of positions the engine
 * opened against it, and hands each to a live {@link StrategyTracker}. The money
 * on this page is the server's — the socket only tells the client when to re-read
 * (see the tracker's own note), so the figures here can never drift from the
 * wallet or the ledger.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardStrategyPage() {
  const user = await requireSessionUser();

  const investments = await listInvestments(user.id);
  const open = investments.filter(
    (investment) => investment.status === 'ACTIVE' || investment.status === 'PAUSED',
  );
  const details = await Promise.all(
    open.map((investment) => getInvestmentForUser(user.id, investment.id)),
  );

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Managed strategies"
        title="Active strategy tracker"
        description="Capital deployed, live P/L and every trade the engine has booked under each plan — with the controls to pause, resume or close."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Strategy' }]}
      />

      {details.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={Layers}
            title="No active strategy"
            description="Deploy capital into a plan and this page will track it: live P/L, the engine's trade log, and pause or withdraw controls. Until then there is nothing at risk and nothing to show."
            action={
              <Button asChild variant="primary" size="sm" className="h-10 sm:h-8">
                <Link href="/dashboard/plans">Browse plans</Link>
              </Button>
            }
          />
        </div>
      ) : (
        details.map((investment) => (
          <StrategyTracker key={investment.id} investment={investment} />
        ))
      )}
    </Section>
  );
}
