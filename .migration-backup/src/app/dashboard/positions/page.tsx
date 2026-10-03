import Link from 'next/link';

import { OpenPositions } from '@/components/dashboard/open-positions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { listInvestments, listPositions } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';

/**
 * `/dashboard/positions` — the open book.
 *
 * Same live table as the trading screen, without the chart. Closed trades live
 * under History; this page deliberately shows only what is still open.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardPositionsPage() {
  const user = await requireSessionUser();

  const [positions, investments] = await Promise.all([
    listPositions(user.id),
    listInvestments(user.id),
  ]);

  const openPositions = positions.filter((position) => position.status === 'OPEN');
  const activeInvestment =
    investments.find((investment) => investment.status === 'ACTIVE') ??
    investments.find((investment) => investment.status === 'PAUSED') ??
    null;

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        title="Open positions"
        description="Every position the broker currently holds for your investments, with live deltas folded in as they arrive."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Positions' }]}
        actions={
          <Button asChild variant="secondary" size="sm" className="h-10 sm:h-8">
            <Link href="/dashboard/history">Closed trades</Link>
          </Button>
        }
      />

      <OpenPositions
        investmentId={activeInvestment?.id ?? null}
        initialPositions={openPositions}
        emptyDescription="Nothing is open right now. Positions appear here from broker-confirmed fills only."
      />
    </Section>
  );
}
