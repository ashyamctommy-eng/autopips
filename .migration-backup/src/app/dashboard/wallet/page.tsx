import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Coins,
  Layers,
  ShieldAlert,
  Wallet,
} from 'lucide-react';

import { WalletDepositList, WalletWithdrawalList } from '@/components/dashboard/wallet-activity';
import { MetricTile } from '@/components/shared/metric-tile';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Usd } from '@/components/shared/money';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { getOverview, listInvestments } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listDeposits, listWithdrawals } from '@/server/modules/payments/payments.service';

/**
 * Wallet (server component).
 *
 * A consolidated *overview* of the money position — not a second implementation
 * of the settlement flows. Every figure comes from a call the deposits,
 * withdrawals or overview pages already make, and every action links into the
 * page that owns it:
 *
 *   equity / withdrawable / deployed   ← getOverview()  → getAccountSnapshot()
 *   idle cash / lifetime totals        ← getOverview().breakdown
 *   pending payouts                    ← getOverview().pendingWithdrawals
 *   deployed investment count          ← listInvestments()
 *   recent deposits / withdrawals      ← listDeposits() / listWithdrawals()
 *
 * The service boundary is respected literally: no balance is recomputed here,
 * and `withdrawableBalance` is the only number this page offers as "available".
 * A figure the ledger snapshot does not expose is reported as a fact we do have
 * (e.g. the count of pending deposits) with the missing aggregate named — never
 * derived and presented as a balance.
 */

export const dynamic = 'force-dynamic';

/**
 * Settlement rows read for the pending-deposit count. Matches the window the
 * deposits page itself reads, so the two surfaces agree on "on this page".
 */
const SETTLEMENT_TAKE = 50;
/** Rows rendered in the wallet's recent-activity tables. */
const RECENT_TAKE = 5;

/** One labelled figure in a summary panel. */
function FigureRow({
  label,
  hint,
  value,
}: {
  label: string;
  hint?: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm leading-tight text-base-100">{label}</p>
        {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </div>
      <div className="shrink-0 text-right text-sm">{value}</div>
    </div>
  );
}

/**
 * The withdraw entry point.
 *
 * Identity verification is enforced by the withdrawals flow itself; this action
 * mirrors that gate so the wallet never offers a payout the server would refuse.
 * When the account is not verified the button is non-interactive and the
 * adjacent action links to `/dashboard/kyc` — the same destination the
 * withdrawals page sends you to.
 */
function WithdrawAction({ kycApproved }: { kycApproved: boolean }) {
  if (kycApproved) {
    return (
      <Button asChild variant="secondary" size="sm">
        <Link href="/dashboard/withdrawals">
          <ArrowUpFromLine aria-hidden />
          Withdraw
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled
        aria-disabled="true"
        title="Identity verification must be approved before a payout can be requested."
      >
        <ArrowUpFromLine aria-hidden />
        Withdraw
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard/kyc">
          <ShieldAlert aria-hidden />
          Verify to withdraw
        </Link>
      </Button>
    </>
  );
}

export default async function DashboardWalletPage() {
  const user = await requireSessionUser();

  const [overview, investments, deposits, withdrawals] = await Promise.all([
    getOverview(user.id),
    listInvestments(user.id),
    listDeposits(user.id, { take: SETTLEMENT_TAKE }),
    listWithdrawals(user.id, { take: SETTLEMENT_TAKE }),
  ]);

  const kycApproved = user.kycStatus === 'APPROVED';
  const { breakdown } = overview;

  const deployedInvestments = investments.filter(
    (investment) => investment.status === 'ACTIVE' || investment.status === 'PAUSED',
  );

  // A fact read straight off the returned rows — not a sum, and not claimed as a
  // balance. `getOverview()` exposes no pending-deposit aggregate, and the list
  // above is a window, so this page refuses to present a money total as if it
  // were authoritative.
  const pendingDeposits = deposits.items.filter(
    (deposit) => deposit.status === 'PENDING' || deposit.status === 'WAITING',
  );

  const recentDeposits = deposits.items.slice(0, RECENT_TAKE);
  const recentWithdrawals = withdrawals.items.slice(0, RECENT_TAKE);

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Treasury"
        title="Wallet"
        description="Your consolidated money position. Balances are read from the ledger; settlements are handled on the deposits and withdrawals pages this overview links to."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Wallet' }]}
        actions={
          <>
            <Button asChild variant="primary" size="sm">
              <Link href="/dashboard/deposits">
                <ArrowDownToLine aria-hidden />
                Deposit
              </Link>
            </Button>
            <WithdrawAction kycApproved={kycApproved} />
          </>
        }
      />

      {!kycApproved ? (
        <Alert variant="warn">
          <AlertTitle>Identity verification is required</AlertTitle>
          <AlertDescription>
            Deposits and withdrawals are limited to accounts a compliance officer has verified. Your
            current status is {user.kycStatus.replace(/_/g, ' ').toLowerCase()}.
            <span className="mt-2 block">
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/kyc">Open identity verification</Link>
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Total account value"
          value={<Usd value={overview.equity} tone="neutral" />}
          sub="Equity per the ledger"
          icon={Wallet}
        />
        <MetricTile
          label="Withdrawable now"
          value={<Usd value={overview.withdrawableBalance} tone="neutral" />}
          sub="The only balance available to withdraw"
          icon={Banknote}
        />
        <MetricTile
          label="Capital deployed"
          value={<Usd value={overview.activeCapital} tone="neutral" />}
          sub={`${deployedInvestments.length} active ${
            deployedInvestments.length === 1 ? 'investment' : 'investments'
          }`}
          icon={Layers}
        />
        <MetricTile
          label="Idle cash"
          value={<Usd value={breakdown.confirmedDeposits} tone="neutral" />}
          sub="Confirmed, not yet deployed"
          icon={Coins}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="p-5 pb-2">
            <CardTitle>Where the balance sits</CardTitle>
            <p className="text-xs leading-relaxed text-muted">
              Each term below is read from the same ledger snapshot the overview page renders.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col p-5 pt-2">
            <FigureRow
              label="Withdrawable now"
              hint="Equity minus capital deployed in active strategies and minus payouts already in flight. This is the single authority for what can be withdrawn."
              value={<Usd value={overview.withdrawableBalance} tone="neutral" />}
            />
            <FigureRow
              label="Capital deployed"
              hint="Capital currently allocated to a strategy (active and paused investments)."
              value={<Usd value={overview.activeCapital} tone="neutral" />}
            />
            <FigureRow
              label="Idle cash"
              hint="Confirmed deposits not yet deployed into a strategy."
              value={<Usd value={breakdown.confirmedDeposits} tone="neutral" />}
            />
            <FigureRow
              label="Net contributed capital"
              hint="Confirmed deposits minus paid withdrawals — the capital actually in the account."
              value={<Usd value={breakdown.netContributedCapital} tone="neutral" />}
            />

            <Separator className="my-2" />

            <FigureRow
              label="Total account value"
              value={<Usd value={overview.equity} tone="neutral" className="font-semibold" />}
            />

            <code className="mt-3 break-words rounded-lg border border-line bg-base-900/60 p-3 font-mono text-[0.7rem] leading-relaxed text-muted">
              {overview.formula}
            </code>
            <p className="mt-2 text-xs italic leading-relaxed text-muted">{overview.disclaimer}</p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="p-5 pb-2">
              <CardTitle>Settlement in flight</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col p-5 pt-2">
              <FigureRow
                label="Pending payouts"
                hint="Requested, not yet paid. Reduces what you can withdraw again, not your equity."
                value={<Usd value={overview.pendingWithdrawals} tone="neutral" />}
              />
              <FigureRow
                label="Deposits awaiting confirmation"
                hint="Counted across the deposit history window, matching the deposits page."
                value={`${pendingDeposits.length}`}
              />
              <FigureRow
                label="Deposits credited"
                hint="Lifetime, per the ledger."
                value={<Usd value={breakdown.totalCreditedDeposits} tone="neutral" />}
              />
              <FigureRow
                label="Withdrawals paid"
                hint="Lifetime, per the ledger."
                value={<Usd value={breakdown.totalPaidWithdrawals} tone="neutral" />}
              />

              <p className="mt-1 text-xs leading-relaxed text-muted">
                A pending deposit is an intent, not balance: it enters the ledger only once the
                provider confirms the transfer. The ledger snapshot exposes no aggregate for
                deposits still awaiting confirmation, so only their count is shown rather than an
                estimated total.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-5 pb-2">
              <CardTitle>Move money</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 p-5 pt-2">
              <p className="text-xs leading-relaxed text-muted">
                Deposits and payouts each have their own page — the wallet links straight into them
                and keeps no balances of its own.
              </p>
              <div className="flex flex-col gap-2">
                <Button asChild variant="primary" size="sm">
                  <Link href="/dashboard/deposits">
                    <ArrowDownToLine aria-hidden />
                    Deposit to wallet
                  </Link>
                </Button>
                {kycApproved ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/dashboard/withdrawals">
                      <ArrowUpFromLine aria-hidden />
                      Request a withdrawal
                    </Link>
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/dashboard/kyc">
                      <ShieldAlert aria-hidden />
                      Verification required to withdraw
                    </Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
            Recent activity
          </h2>
          <p className="mt-1 text-sm text-muted">
            The newest settlements on each side. Full histories live on the deposits and withdrawals
            pages.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 p-5 pb-3">
              <CardTitle className="text-sm">Recent deposits</CardTitle>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/deposits">View all</Link>
              </Button>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <WalletDepositList items={recentDeposits} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 p-5 pb-3">
              <CardTitle className="text-sm">Recent withdrawals</CardTitle>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/withdrawals">View all</Link>
              </Button>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <WalletWithdrawalList items={recentWithdrawals} />
            </CardContent>
          </Card>
        </div>
      </div>
    </Section>
  );
}
