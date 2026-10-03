import type { Metadata } from 'next';

import { WithdrawalDecisions } from '@/components/admin/withdrawal-decisions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { attachWithdrawalEmails, requireStaffPage, sortWithdrawalQueue } from '../_lib/admin-data';
import { adminListWithdrawals } from '@/server/modules/payments/payments.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Withdrawals',
  description: 'Payout queue and the single human gate that lets funds leave the platform.',
};

/**
 * Payout queue.
 *
 * `adminListWithdrawals()` returns the newest 100 rows; unsettled requests are
 * sorted to the top so the queue an operator must act on is the first thing on
 * the screen. Client emails are joined here (the DTO carries no identity) so a
 * reviewer is not approving an amount against a bare payout address.
 */
export default async function AdminWithdrawalsPage() {
  const user = await requireStaffPage();
  const page = await adminListWithdrawals({ take: 100 });
  const rows = sortWithdrawalQueue(await attachWithdrawalEmails(page.items));

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Payments"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Withdrawals' }]}
        title="Withdrawal queue"
        description="Approve or reject client payouts. Approving is the only action on this platform that moves money out; it is recorded against your admin id with the reason and, when settled, the transaction hash."
      />

      <div className="mt-6">
        <WithdrawalDecisions initialItems={rows} canDecide={user.role === 'ADMIN'} />
      </div>
    </Section>
  );
}
