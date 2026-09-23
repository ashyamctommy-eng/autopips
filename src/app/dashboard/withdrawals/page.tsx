import Link from 'next/link';
import {
  WithdrawalForm,
  WithdrawalHistory,
} from '@/components/dashboard/withdrawal-form';
import { MetricTile } from '@/components/shared/metric-tile';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Usd } from '@/components/shared/money';
import { D, sum } from '@/lib/money';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getOverview } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listSupportedCurrencies, listWithdrawals } from '@/server/modules/payments/payments.service';

/**
 * Withdrawals (server component).
 *
 * The available balance comes from the ledger snapshot (`getOverview`), which
 * already subtracts capital deployed in active strategies and payouts in flight.
 * Identity verification is required before a payout can be requested, and the
 * settlement itself is an operator action — this page says both plainly rather
 * than implying an instant transfer.
 */

export const dynamic = 'force-dynamic';

const HISTORY_TAKE = 50;

export default async function DashboardWithdrawalsPage() {
  const user = await requireSessionUser();

  const [overview, withdrawals, supported] = await Promise.all([
    getOverview(user.id),
    listWithdrawals(user.id, { take: HISTORY_TAKE }),
    listSupportedCurrencies(),
  ]);

  const kycApproved = user.kycStatus === 'APPROVED';
  const finished = withdrawals.items.filter((withdrawal) => withdrawal.status === 'FINISHED');
  // Summed in Decimal at the server boundary, then degraded once for display.
  const settledTotal = sum(finished.map((withdrawal) => D(withdrawal.amountUsd))).toNumber();

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settlements"
        title="Withdrawals"
        description="Payouts are reviewed by an operator and signed against your verified balance. Only a finished payout reduces your account value."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Withdrawals' }]}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/dashboard/deposits">Deposits</Link>
          </Button>
        }
      />

      {!kycApproved ? (
        <Alert variant="warn">
          <AlertTitle>Identity verification is required</AlertTitle>
          <AlertDescription>
            Withdrawals are limited to accounts a compliance officer has verified. Your current
            status is {user.kycStatus.replace(/_/g, ' ').toLowerCase()}.
            <span className="mt-2 block">
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/kyc">Open identity verification</Link>
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Withdrawable now"
          value={<Usd value={overview.withdrawableBalance} tone="neutral" />}
          sub="Equity minus deployed capital and in-flight payouts"
        />
        <MetricTile
          label="Pending payouts"
          value={<Usd value={overview.pendingWithdrawals} tone="neutral" />}
          sub="Requested, not yet paid"
        />
        <MetricTile
          label="Paid out"
          value={<Usd value={settledTotal} tone="neutral" />}
          sub={`${finished.length} finished of ${withdrawals.items.length} on this page`}
        />
      </div>

      <WithdrawalForm
        withdrawableBalance={overview.withdrawableBalance}
        pendingWithdrawals={overview.pendingWithdrawals}
        kycApproved={kycApproved}
        currencies={supported.currencies}
      />

      <WithdrawalHistory items={withdrawals.items} />
    </Section>
  );
}
