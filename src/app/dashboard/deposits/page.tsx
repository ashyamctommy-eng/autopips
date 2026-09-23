import { DepositForm, DepositHistory } from '@/components/dashboard/deposit-form';
import { MetricTile } from '@/components/shared/metric-tile';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Usd } from '@/components/shared/money';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getOverview } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listDeposits, listSupportedCurrencies } from '@/server/modules/payments/payments.service';

/**
 * Deposits (server component).
 *
 * Reads the client's deposit history, the currency allow-list and the ledger's
 * idle-cash figure, then hands them to the client form. The newest deposit that
 * the provider has not finished with is passed down so its address and QR code
 * survive a refresh — a client who reloads the page while a transfer is in
 * flight still sees exactly where to send it.
 */

export const dynamic = 'force-dynamic';

const HISTORY_TAKE = 50;

export default async function DashboardDepositsPage() {
  const user = await requireSessionUser();

  const [deposits, supported, overview] = await Promise.all([
    listDeposits(user.id, { take: HISTORY_TAKE }),
    listSupportedCurrencies(),
    getOverview(user.id),
  ]);

  const openDeposit =
    deposits.items.find((deposit) => deposit.status === 'PENDING' || deposit.status === 'WAITING') ??
    null;

  const settled = deposits.items.filter((deposit) => deposit.status === 'FINISHED').length;

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settlements"
        title="Deposits"
        description="Crypto payments issued through our settlement provider. A deposit becomes idle cash only after the provider confirms the transfer."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Deposits' }]}
        actions={openDeposit ? <StatusBadge status={openDeposit.status} kind="payment" showIcon /> : null}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Idle cash"
          value={<Usd value={overview.breakdown.confirmedDeposits} tone="neutral" />}
          sub="Confirmed deposits not yet deployed"
        />
        <MetricTile
          label="Deposits credited"
          value={<Usd value={overview.breakdown.totalCreditedDeposits} tone="neutral" />}
          sub="Lifetime, per the ledger"
        />
        <MetricTile
          label="Settled payments"
          value={settled}
          sub={`of ${deposits.items.length} on this page`}
        />
      </div>

      <Alert variant="info">
        <AlertTitle>How a deposit is credited</AlertTitle>
        <AlertDescription>
          The provider watches the address it issued. When the transfer arrives, a signed callback
          credits your account — the credited amount is capped at the amount you requested and at
          the provider&apos;s own price, and it is always derived from what the network actually
          received. A short payment is credited as the amount that arrived.
        </AlertDescription>
      </Alert>

      <DepositForm
        currencies={supported.currencies}
        providerReachable={supported.providerReachable}
        initialDeposit={openDeposit}
      />

      <Card>
        <CardHeader className="p-5 pb-2">
          <CardTitle>Networks in use</CardTitle>
          <p className="text-xs leading-relaxed text-muted">
            Only these networks are offered for settlement. Sending an asset on a different network
            is unrecoverable, so the deposit panel always names the network next to the address.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-5 pt-2">
          {supported.currencies.length === 0 ? (
            <span className="text-sm text-muted">No settlement currency is enabled on this platform.</span>
          ) : (
            supported.currencies.map((currency) => (
              <span
                key={currency.currency}
                className="flex items-center gap-2 rounded-lg border border-line bg-base-900/40 px-3 py-1.5 text-xs"
              >
                <span className="text-base-100">{currency.symbol}</span>
                <span className="text-muted">{currency.network}</span>
                {currency.providerVerified ? null : (
                  <span className="text-warn-400">unconfirmed</span>
                )}
              </span>
            ))
          )}
        </CardContent>
      </Card>

      <DepositHistory items={deposits.items} />
    </Section>
  );
}
