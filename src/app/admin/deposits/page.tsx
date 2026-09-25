import type { Metadata } from 'next';

import { DepositManager, type DepositRow } from '@/components/admin/deposit-manager';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { adminListDeposits } from '@/server/modules/payments/payments.service';
import { requireStaffPage } from '../_lib/admin-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Deposits',
  description: 'Client funds in: provider-confirmed payments and operator credits.',
};

/**
 * Deposits.
 *
 * The other half of the payments picture — `/admin/withdrawals` covers funds
 * leaving, this covers funds arriving. Client emails come back with the rows
 * (`adminListDeposits` joins them), because an operator cannot act on an amount
 * with no account attached.
 *
 * Manual credits are ADMIN-only at the API level; a TRADING_MANAGER sees the
 * list and no credit button, rather than a button that would 403.
 */
export default async function AdminDepositsPage() {
  const user = await requireStaffPage();
  const page = await adminListDeposits({ take: 100 });

  const rows: DepositRow[] = page.items.map((item) => ({
    id: item.id,
    userEmail: item.userEmail,
    userName: item.userName,
    amountUsd: item.amountUsd,
    cryptoCurrency: item.cryptoCurrency,
    paymentId: item.paymentId,
    status: item.status,
    createdAt: item.createdAt,
  }));

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Payments"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Deposits' }]}
        title="Deposits"
        description="Every deposit the platform has recorded. Provider payments arrive confirmed by NOWPayments; operator credits are labelled MANUAL and carry the reason and the admin who made them in the audit trail."
      />

      <div className="mt-6">
        <DepositManager initialItems={rows} canCredit={user.role === 'ADMIN'} />
      </div>
    </Section>
  );
}
