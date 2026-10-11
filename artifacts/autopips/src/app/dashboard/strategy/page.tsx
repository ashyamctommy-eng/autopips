import Link from '@/lib/next/link';
import { Layers, TriangleAlert } from 'lucide-react';

import { StrategyTracker } from '@/components/dashboard/strategy-tracker';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
 *
 * FAILURE POLICY — this page is a READ-ONLY view, so a read that fails degrades
 * here and never reaches the route error boundary. `Promise.all` over the detail
 * reads used to mean one bad read replaced the entire page with "Something went
 * wrong"; that is precisely how a missing RPC allow-list entry (the tracker's
 * `getInvestmentForUser` read) presented to clients who held capital, while an
 * account with nothing deployed saw the ordinary empty state and no fault at all.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardStrategyPage() {
  const user = await requireSessionUser();

  const investments = await listInvestments(user.id);
  const open = investments.filter(
    (investment) => investment.status === 'ACTIVE' || investment.status === 'PAUSED',
  );

  // Each investment is read independently so one failure cannot take the others
  // (or the page header, breadcrumb and plan link) down with it.
  const settled = await Promise.allSettled(
    open.map((investment) => getInvestmentForUser(user.id, investment.id)),
  );
  const details = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const failed = settled.length - details.length;

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Managed strategies"
        title="Active strategy tracker"
        description="Capital deployed, live P/L and every trade the engine has booked under each plan — with the controls to pause, resume or close."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Strategy' }]}
      />

      {failed > 0 ? (
        <Alert variant="warn">
          <AlertTitle>
            {failed === 1
              ? 'One strategy could not be loaded'
              : `${failed} strategies could not be loaded`}
          </AlertTitle>
          <AlertDescription>
            The figures below are the strategies that did load. No balance or trade record was
            changed by the failed read —{' '}
            <Link href="/dashboard/strategy" className="underline underline-offset-2 hover:text-base-100">
              reload the page
            </Link>{' '}
            to try again, and contact support if it persists.
          </AlertDescription>
        </Alert>
      ) : null}

      {details.length === 0 ? (
        <div className="surface">
          {failed > 0 ? (
            <EmptyState
              icon={TriangleAlert}
              title="Strategy data is unavailable"
              description="The platform could not read the strategies backed by your deployed capital just now. This is a read failure, not a change to your money — your investments and their positions are unaffected, and this page will show them again on the next successful load."
              action={
                <Button asChild variant="outline" size="sm" className="h-10 sm:h-8">
                  <Link href="/dashboard/strategy">Try again</Link>
                </Button>
              }
            />
          ) : (
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
          )}
        </div>
      ) : (
        details.map((investment) => (
          <StrategyTracker key={investment.id} investment={investment} />
        ))
      )}
    </Section>
  );
}
