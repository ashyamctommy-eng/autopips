'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpFromLine, Info } from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/use-toast';
import { Usd } from '@/components/shared/money';
import { assetMeta } from '@/lib/contracts';
import { formatUsd } from '@/lib/money';
import { relativeTime, truncateMiddle } from '@/lib/utils';
import type { WithdrawalDTO } from '@/types/api';

/**
 * Withdrawal request form (client component).
 *
 * Money leaving the platform is gated on three things the server enforces and
 * this form mirrors for fast feedback:
 *   1. APPROVED KYC — a client who is not verified cannot request a payout;
 *   2. the ledger's own withdrawable balance — capital deployed in a strategy
 *      (and any payout already in flight) is not withdrawable;
 *   3. a payout address that matches the selected network's format.
 *
 * The address rules below are a client-side mirror of `validatePayoutAddress()`
 * in the payments service (a typo gate, not a checksum validator): the server
 * remains the authority and its rejection message is what the user sees.
 */

/** Mirror of DEPOSIT_MIN semantics for withdrawals: any positive 2dp amount. */
const MIN_WITHDRAWAL_USD = 0.01;

/** Structural copy of the payments service's SupportedCurrency. */
export interface PaymentCurrencyOption {
  currency: string;
  symbol: string;
  label: string;
  network: string;
  providerVerified: boolean;
  minPayAmount: number | null;
  minAmountUsd: number | null;
}

export interface WithdrawalFormProps {
  /** Ledger-derived balance available to withdraw right now. */
  withdrawableBalance: number;
  /** Payouts requested but not yet paid — already excluded from the balance. */
  pendingWithdrawals: number;
  kycApproved: boolean;
  currencies: PaymentCurrencyOption[];
}

/* ── payout address shapes, per network (mirror of the server's rules) ────── */
const TRC20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const BTC_BECH32 = /^bc1[02-9ac-hj-np-z]{11,71}$/;
const BTC_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_BECH32 = /^ltc1[02-9ac-hj-np-z]{11,71}$/;
const LTC_LEGACY = /^[LM3][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const GENERIC = /^[A-Za-z0-9:_-]+$/;

function addressProblem(currency: string, address: string): string | null {
  const value = address.trim();
  if (value.length === 0) return 'Enter the payout address.';
  if (value.length < 20 || value.length > 128) {
    return 'That address length looks wrong.';
  }
  switch (currency) {
    case 'usdttrc20':
    case 'trx':
      return TRC20.test(value) ? null : 'TRC20 addresses start with "T" and are 34 characters long.';
    case 'usdterc20':
    case 'usdtbsc':
    case 'usdc':
    case 'bnb':
    case 'eth':
      return EVM.test(value) ? null : 'This network expects a 0x-prefixed 40-hex-character address.';
    case 'btc':
      return BTC_BECH32.test(value) || BTC_LEGACY.test(value)
        ? null
        : 'Bitcoin addresses are bech32 (bc1…) or legacy 1…/3… .';
    case 'ltc':
      return LTC_BECH32.test(value) || LTC_LEGACY.test(value)
        ? null
        : 'Litecoin addresses are bech32 (ltc1…) or legacy L…/M… .';
    default:
      return GENERIC.test(value) ? null : 'That address contains unexpected characters.';
  }
}

function serverError(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

function isWithdrawalDTO(value: unknown): value is WithdrawalDTO {
  if (typeof value !== 'object' || value === null) return false;
  const withdrawal = value as Record<string, unknown>;
  return (
    typeof withdrawal.id === 'string' &&
    typeof withdrawal.amountUsd === 'number' &&
    typeof withdrawal.cryptoCurrency === 'string' &&
    typeof withdrawal.payoutAddress === 'string' &&
    typeof withdrawal.status === 'string'
  );
}

export function WithdrawalForm({
  withdrawableBalance,
  pendingWithdrawals,
  kycApproved,
  currencies,
}: WithdrawalFormProps) {
  const router = useRouter();

  const [amount, setAmount] = React.useState('');
  const [currency, setCurrency] = React.useState(currencies[0]?.currency ?? '');
  const [address, setAddress] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [requested, setRequested] = React.useState<WithdrawalDTO | null>(null);

  const option = currencies.find((entry) => entry.currency === currency) ?? null;
  const meta = option ?? {
    currency,
    symbol: assetMeta(currency).symbol,
    label: assetMeta(currency).label,
    network: assetMeta(currency).network,
    minPayAmount: null,
    minAmountUsd: null,
    providerVerified: false,
  };

  const parsedAmount = Number(amount);
  const amountValid =
    amount.trim() !== '' &&
    Number.isFinite(parsedAmount) &&
    parsedAmount >= MIN_WITHDRAWAL_USD &&
    Math.round(parsedAmount * 100) === parsedAmount * 100;
  const overBalance = amountValid && parsedAmount > withdrawableBalance;
  const addressError = address.trim() ? addressProblem(currency, address) : null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!kycApproved) {
      setError('Identity verification must be approved before you can withdraw.');
      return;
    }
    if (!amountValid) {
      setError('Enter a positive amount with at most two decimal places.');
      return;
    }
    if (overBalance) {
      setError(`You can withdraw at most $${formatUsd(withdrawableBalance)} right now.`);
      return;
    }
    if (!currency) {
      setError('Choose a payout currency.');
      return;
    }
    const problem = addressProblem(currency, address);
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/payments/withdrawals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          amountUsd: parsedAmount,
          cryptoCurrency: currency,
          payoutAddress: address.trim(),
        }),
      });
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null
          ? (body as { ok?: unknown; data?: unknown })
          : null;
      if (!response.ok || data?.ok !== true || !isWithdrawalDTO(data.data)) {
        const message = serverError(body, `The request was rejected (HTTP ${response.status}).`);
        setError(message);
        toast({ title: 'Withdrawal not requested', description: message, variant: 'danger' });
        return;
      }
      setRequested(data.data);
      setAmount('');
      setAddress('');
      toast({
        title: 'Withdrawal requested',
        description: 'Your payout is queued for operator review.',
        variant: 'success',
      });
      router.refresh();
    } catch {
      const message = 'The request could not be sent. Check your connection and try again.';
      setError(message);
      toast({ title: 'Withdrawal not requested', description: message, variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="p-5 pb-2">
        <CardTitle>Request a withdrawal</CardTitle>
        <p className="text-xs leading-relaxed text-muted">
          Payouts are reviewed and settled by an operator against your verified balance. Only a
          withdrawal the operator has completed (FINISHED) reduces your account value — a request
          that is still awaiting review or in flight reduces what you can withdraw again, but not
          your equity.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-5 pt-2">
        {!kycApproved ? (
          <Alert variant="warn">
            <AlertTitle>Identity verification required</AlertTitle>
            <AlertDescription>
              Withdrawals are only available to verified accounts. Submit your documents on the
              identity page and wait for a compliance officer to approve them.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-base-900/40 p-3">
            <span className="text-xs uppercase tracking-wide text-muted">Withdrawable now</span>
            <Usd value={withdrawableBalance} tone="neutral" className="text-[1rem] font-semibold" />
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-base-900/40 p-3">
            <span className="text-xs uppercase tracking-wide text-muted">In flight</span>
            <Usd value={pendingWithdrawals} tone="neutral" className="text-[1rem]" />
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-base-900/40 p-3">
            <span className="text-xs uppercase tracking-wide text-muted">Withdrawal fee</span>
            <span className="text-[1rem] text-base-100">
              <Usd value={0} tone="neutral" />
            </span>
          </div>
        </div>

        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="withdrawal-amount">Amount (USD)</Label>
            <div className="flex items-start gap-2">
              <Input
                id="withdrawal-amount"
                name="amountUsd"
                type="number"
                inputMode="decimal"
                min={MIN_WITHDRAWAL_USD}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                aria-describedby="withdrawal-amount-hint"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setAmount(withdrawableBalance.toFixed(2))}
                disabled={withdrawableBalance <= 0}
              >
                Max
              </Button>
            </div>
            <p id="withdrawal-amount-hint" className="text-xs text-muted">
              Available: <Usd value={withdrawableBalance} tone="neutral" />. Capital deployed in a
              strategy is released only when the strategy closes it.
            </p>
            {overBalance ? (
              <p role="alert" className="text-xs text-loss-400">
                That is more than the withdrawable balance.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="withdrawal-currency">Payout currency</Label>
            <Select value={currency} onValueChange={setCurrency} disabled={currencies.length === 0}>
              <SelectTrigger id="withdrawal-currency">
                <SelectValue placeholder="No currency available" />
              </SelectTrigger>
              <SelectContent>
                {currencies.map((entry) => (
                  <SelectItem key={entry.currency} value={entry.currency}>
                    {entry.symbol} — {entry.network}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted">
              {meta.label} · {meta.network}
            </p>
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="withdrawal-address">Payout address</Label>
            <Input
              id="withdrawal-address"
              name="payoutAddress"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder={currency === 'usdttrc20' || currency === 'trx' ? 'T…' : '0x…'}
              aria-invalid={Boolean(addressError)}
              aria-describedby="withdrawal-address-hint"
              autoComplete="off"
              spellCheck={false}
            />
            <p id="withdrawal-address-hint" className="text-xs leading-relaxed text-muted">
              Must be a {meta.symbol} address on {meta.network}. The format is checked here and
              again on the server; an operator confirms it before the payout is signed.
            </p>
            {addressError ? (
              <p role="alert" className="text-xs text-loss-400">
                {addressError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-line bg-base-900/50 p-3 sm:col-span-2">
            <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <Info aria-hidden className="size-3.5" />
              Settlement
            </span>
            <span className="text-xs leading-relaxed text-muted">
              No withdrawal fee is charged today; the fee column is recorded as 0.00 on every
              request so a future fee schedule cannot be applied retroactively. Payouts are settled
              manually by an operator — the transaction hash appears on this page once the payment
              has been broadcast.
            </span>
            {amountValid ? (
              <span className="text-sm text-base-100">
                You will receive <Usd value={parsedAmount} tone="neutral" /> in {meta.symbol} (fee{' '}
                <Usd value={0} tone="neutral" />).
              </span>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-xs text-loss-400 sm:col-span-2">
              {error}
            </p>
          ) : null}

          <div className="sm:col-span-2">
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || !kycApproved || currencies.length === 0}
            >
              {submitting ? <Spinner size="sm" label="Submitting" /> : <ArrowUpFromLine aria-hidden />}
              Request withdrawal
            </Button>
          </div>
        </form>

        {requested ? (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-base-900/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-base-100">Request recorded</p>
                <p className="text-xs text-muted">
                  <Usd value={requested.amountUsd} tone="neutral" /> in{' '}
                  {assetMeta(requested.cryptoCurrency).symbol} to{' '}
                  {truncateMiddle(requested.payoutAddress, 10, 6)}
                </p>
              </div>
              <StatusBadge status={requested.status} kind="payment" showIcon />
            </div>
            <Separator />
            <p className="text-xs leading-relaxed text-muted">
              Your equity is unchanged for now. The amount leaves the account when the operator marks
              the payout finished, at which point a transaction hash is recorded against this row.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface WithdrawalHistoryProps {
  items: WithdrawalDTO[];
}

export function WithdrawalHistory({ items }: WithdrawalHistoryProps) {
  const columns = React.useMemo<DataTableColumn<WithdrawalDTO>[]>(
    () => [
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (withdrawal) => <Usd value={withdrawal.amountUsd} tone="neutral" />,
      },
      {
        key: 'currency',
        header: 'Currency',
        cell: (withdrawal) => {
          const meta = assetMeta(withdrawal.cryptoCurrency);
          return (
            <span className="flex flex-col">
              <span className="text-base-100">{meta.symbol}</span>
              <span className="text-xs text-muted">{meta.network}</span>
            </span>
          );
        },
      },
      {
        key: 'address',
        header: 'Payout address',
        cell: (withdrawal) => (
          <span className="font-mono text-xs text-muted" title={withdrawal.payoutAddress}>
            {truncateMiddle(withdrawal.payoutAddress, 10, 6)}
          </span>
        ),
      },
      {
        key: 'fee',
        header: 'Fee',
        align: 'right',
        cell: (withdrawal) => <Usd value={withdrawal.feeUsd} tone="neutral" />,
      },
      {
        key: 'status',
        header: 'Status',
        cell: (withdrawal) => <StatusBadge status={withdrawal.status} kind="payment" showIcon />,
      },
      {
        key: 'tx',
        header: 'Transaction',
        cell: (withdrawal) =>
          withdrawal.txHash ? (
            <span className="font-mono text-xs text-brand-300" title={withdrawal.txHash}>
              {truncateMiddle(withdrawal.txHash, 10, 6)}
            </span>
          ) : (
            <span className="text-xs text-muted">—</span>
          ),
      },
      {
        key: 'created',
        header: 'Requested',
        align: 'right',
        cell: (withdrawal) => (
          <time
            dateTime={withdrawal.createdAt}
            suppressHydrationWarning
            className="text-xs tabular-nums text-muted"
          >
            {relativeTime(withdrawal.createdAt)}
          </time>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
          Withdrawal history
        </h2>
        <p className="mt-1 text-sm text-muted">
          Requests, their operator decisions and the broadcast hash when there is one.
        </p>
      </div>
      <DataTable<WithdrawalDTO>
        columns={columns}
        rows={items}
        getRowKey={(withdrawal) => withdrawal.id}
        emptyState={
          <EmptyState
            size="sm"
            title="No withdrawals yet"
            description="A request appears here as soon as it is submitted, before any operator has reviewed it."
          />
        }
      />
    </div>
  );
}
