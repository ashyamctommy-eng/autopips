'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownToLine, Check, Copy, RefreshCw } from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Usd } from '@/components/shared/money';
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
import { assetMeta } from '@/lib/contracts';
import { formatUsd } from '@/lib/money';
import { relativeTime } from '@/lib/utils';
import type { DepositDTO } from '@/types/api';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Deposit creation + settlement panel (client component).
 *
 * The provider is the only party that can quote a crypto amount, and it does so
 * when it creates the payment — so this screen never shows a converted figure
 * it invented. The "estimate" block shows what we can honestly state up front:
 * the USD amount being requested, the network it will be paid on, and the
 * provider's own minimum when it advertised one. The exact amount to send
 * (`payAmount`) appears only once the provider has returned it.
 *
 * `qrcode` is already a dependency of the platform (the 2FA setup route uses it
 * server-side); it is imported dynamically here so it stays out of the initial
 * bundle and no new dependency is added.
 *
 * `currencies` is injected by the server component, which reads the same
 * `listSupportedCurrencies()` service that backs `GET /api/v1/payments/currencies`
 * — one fewer round trip, byte-identical payload (allow-listed currencies,
 * provider-verified flag and provider minimums).
 */

/** Mirror of DEPOSIT_MIN_USD / DEPOSIT_MAX_USD in the payments service. */
const DEPOSIT_MIN_USD = 50;
const DEPOSIT_MAX_USD = 250_000;

/** How often a pending deposit is re-checked against the API. */
const POLL_INTERVAL_MS = 15_000;

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

export interface DepositFormProps {
  currencies: PaymentCurrencyOption[];
  /** False when the provider's currency list could not be read this request. */
  providerReachable: boolean;
  /** Newest pending deposit, so the address survives a page refresh. */
  initialDeposit: DepositDTO | null;
}

/** A deposit we are still waiting on. */
function isAwaiting(deposit: DepositDTO | null): boolean {
  return deposit?.status === 'PENDING' || deposit?.status === 'WAITING';
}

/** Exact crypto amount with the asset's precision, trailing zeros trimmed. */
function formatPayAmount(value: number, currency: string): string {
  const decimals = assetMeta(currency).decimals;
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

function serverError(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

function isDepositDTO(value: unknown): value is DepositDTO {
  if (typeof value !== 'object' || value === null) return false;
  const deposit = value as Record<string, unknown>;
  return (
    typeof deposit.id === 'string' &&
    typeof deposit.depositAddress === 'string' &&
    typeof deposit.payAmount === 'number' &&
    typeof deposit.amountUsd === 'number' &&
    typeof deposit.cryptoCurrency === 'string' &&
    typeof deposit.status === 'string'
  );
}

/** Deposit address + QR + the exact amount to send. */
function DepositPanel({
  deposit,
  onRefresh,
  refreshing,
}: {
  deposit: DepositDTO;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [qrError, setQrError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const meta = assetMeta(deposit.cryptoCurrency);

  React.useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrError(null);
    void import('qrcode')
      .then((module) =>
        module.toDataURL(deposit.depositAddress, {
          type: 'image/png',
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 220,
        }),
      )
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError('The QR code could not be generated in this browser.');
      });
    return () => {
      cancelled = true;
    };
  }, [deposit.depositAddress]);

  const copyAddress = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deposit.depositAddress);
      setCopied(true);
      toast({ title: 'Address copied', variant: 'success' });
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Select the address and copy it manually.',
        variant: 'warn',
      });
    }
  }, [deposit.depositAddress]);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-base-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-base-100">Send exactly this amount</p>
          <p className="text-xs text-muted">
            {formatPayAmount(deposit.payAmount, deposit.cryptoCurrency)} {meta.symbol} on{' '}
            {meta.network}
          </p>
        </div>
        <StatusBadge status={deposit.status} kind="payment" showIcon />
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deposit-address">Deposit address</Label>
            <div className="flex items-start gap-2">
              <code
                id="deposit-address"
                className="min-w-0 flex-1 break-all rounded-md border border-line bg-base-950/70 px-3 py-2 font-mono text-xs text-base-100"
              >
                {deposit.depositAddress}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-10 shrink-0 sm:h-8"
                onClick={() => void copyAddress()}
                aria-label="Copy deposit address"
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex flex-col gap-0.5">
              <dt className="uppercase tracking-wide text-muted">Amount requested</dt>
              <dd className="text-base-100">
                <Usd value={deposit.amountUsd} tone="neutral" />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="uppercase tracking-wide text-muted">Payment reference</dt>
              <dd className="break-all font-mono text-base-100">{deposit.paymentId}</dd>
            </div>
          </dl>

          <Alert variant="warn">
            <AlertTitle>
              Use the {meta.network} network only
            </AlertTitle>
            <AlertDescription>
              Funds sent on any other network — or in any other asset — are unrecoverable. Send the
              exact amount shown above; a short payment is credited as what actually arrived.
            </AlertDescription>
          </Alert>
        </div>

        <div className="flex flex-col items-center gap-2">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URI, no loader needed
            <img
              src={qrDataUrl}
              alt={`Deposit address QR code (${meta.network})`}
              width={220}
              height={220}
              className="h-auto w-full max-w-[220px] rounded-lg border border-line bg-white p-2"
            />
          ) : (
            <div className="flex h-[220px] w-full max-w-[220px] items-center justify-center rounded-lg border border-line bg-base-950/60">
              {qrError ? (
                <span className="px-3 text-center text-xs text-muted">{qrError}</span>
              ) : (
                <Spinner size="lg" tone="brand" label="Rendering QR code" />
              )}
            </div>
          )}
          <span className="text-center text-[0.68rem] leading-relaxed text-muted">
            Scan or copy the address, then send the exact amount.
          </span>
        </div>
      </div>

      <Separator />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {isAwaiting(deposit)
            ? 'This payment is still open. The status is re-checked against the provider.'
            : 'This payment is settled; the status below is final for this record.'}
        </span>
        <span className="flex items-center gap-2">
          <span suppressHydrationWarning>Updated {relativeTime(deposit.updatedAt)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-10 sm:h-8"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Check deposit status now"
          >
            {refreshing ? <Spinner size="sm" label="Checking" /> : <RefreshCw aria-hidden />}
            Check now
          </Button>
        </span>
      </div>
    </div>
  );
}

export function DepositForm({ currencies, providerReachable, initialDeposit }: DepositFormProps) {
  const router = useRouter();

  const [amount, setAmount] = React.useState('');
  const [currency, setCurrency] = React.useState(currencies[0]?.currency ?? '');
  const [selected, setSelected] = React.useState<DepositDTO | null>(initialDeposit);
  const [submitting, setSubmitting] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelected(initialDeposit);
  }, [initialDeposit]);

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
    parsedAmount >= DEPOSIT_MIN_USD &&
    parsedAmount <= DEPOSIT_MAX_USD &&
    Math.round(parsedAmount * 100) === parsedAmount * 100;
  const belowProviderMinimum =
    amountValid && meta.minAmountUsd !== null && parsedAmount < meta.minAmountUsd;

  const refreshDeposit = React.useCallback(async (id: string) => {
    setRefreshing(true);
    try {
      const response = await apiFetch(`/api/v1/payments/deposits/${id}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null
          ? (body as { ok?: unknown; data?: unknown })
          : null;
      const next =
        data?.ok === true && typeof data.data === 'object' && data.data !== null
          ? (data.data as { deposit?: unknown }).deposit
          : null;
      if (isDepositDTO(next)) {
        setSelected(next);
      } else if (response.ok === false) {
        setError(serverError(body, 'The deposit status could not be refreshed.'));
      }
    } catch {
      setError('The deposit status could not be refreshed.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  /* Poll only while the provider has not finished with the payment. */
  React.useEffect(() => {
    if (!selected || !isAwaiting(selected)) return;
    const id = selected.id;
    const timer = window.setInterval(() => {
      void refreshDeposit(id);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [selected, refreshDeposit]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!amountValid) {
      setError(
        `Enter an amount between $${DEPOSIT_MIN_USD} and $${formatUsd(DEPOSIT_MAX_USD)} with at most two decimals.`,
      );
      return;
    }
    if (belowProviderMinimum) {
      setError(
        `The provider's minimum for ${meta.symbol} on ${meta.network} is about $${formatUsd(meta.minAmountUsd ?? 0)}.`,
      );
      return;
    }
    if (!currency) {
      setError('Choose a settlement currency.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiFetch('/api/v1/payments/deposits', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ amountUsd: parsedAmount, cryptoCurrency: currency }),
      });
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null
          ? (body as { ok?: unknown; data?: unknown })
          : null;
      if (!response.ok || data?.ok !== true || !isDepositDTO(data.data)) {
        const message = serverError(body, `The deposit could not be created (HTTP ${response.status}).`);
        setError(message);
        toast({ title: 'Deposit not created', description: message, variant: 'danger' });
        return;
      }
      setSelected(data.data);
      setAmount('');
      toast({
        title: 'Deposit address issued',
        description: 'Send the exact amount shown, on the correct network.',
        variant: 'success',
      });
      router.refresh();
    } catch {
      const message = 'The deposit request could not be sent. Check your connection and try again.';
      setError(message);
      toast({ title: 'Deposit not created', description: message, variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="p-5 pb-2">
        <CardTitle>Create a deposit</CardTitle>
        <p className="text-xs leading-relaxed text-muted">
          Funds are credited to your idle cash once the provider confirms the transfer. Idle cash is
          not traded until you deploy it into a plan.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-5 pt-2">
        {!providerReachable ? (
          <Alert variant="warn">
            <AlertTitle>The payment provider is not reachable right now</AlertTitle>
            <AlertDescription>
              Currencies are still listed from our own allow-list, but minimums and rates cannot be
              confirmed. Creating a deposit may fail until the provider responds.
            </AlertDescription>
          </Alert>
        ) : null}

        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deposit-amount">Amount (USD)</Label>
            <Input
              id="deposit-amount"
              name="amountUsd"
              type="number"
              inputMode="decimal"
              min={DEPOSIT_MIN_USD}
              max={DEPOSIT_MAX_USD}
              step="0.01"
              className="h-10 sm:h-9"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={String(DEPOSIT_MIN_USD)}
              aria-describedby="deposit-amount-hint"
            />
            <p id="deposit-amount-hint" className="text-xs text-muted">
              Minimum <Usd value={DEPOSIT_MIN_USD} tone="neutral" />, maximum{' '}
              <Usd value={DEPOSIT_MAX_USD} tone="neutral" />.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deposit-currency">Currency</Label>
            <Select value={currency} onValueChange={setCurrency} disabled={currencies.length === 0}>
              <SelectTrigger id="deposit-currency" className="h-10 sm:h-9">
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
              {meta.providerVerified ? '' : ' · not confirmed by the provider this request'}
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-line bg-base-900/50 p-3 sm:col-span-2">
            <span className="text-xs uppercase tracking-wide text-muted">Live estimate</span>
            {amountValid ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="text-base-100">
                  You send <Usd value={parsedAmount} tone="neutral" />
                </span>
                <span className="text-muted">
                  You receive {meta.symbol} on {meta.network}
                </span>
                {meta.minPayAmount !== null ? (
                  <span className="text-muted">
                    Provider minimum: {formatPayAmount(meta.minPayAmount, currency)} {meta.symbol}
                    {meta.minAmountUsd !== null ? ` (≈ $${formatUsd(meta.minAmountUsd)})` : ''}
                  </span>
                ) : (
                  <span className="text-muted">Provider minimum not available</span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted">
                Enter an amount to see the currency and network it will be settled on.
              </span>
            )}
            <span className="flex items-start gap-2 text-xs leading-relaxed text-muted">
              <ArrowDownToLine aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              The exact crypto amount is set by the payment provider when the address is issued —
              it is shown below once it is known. We do not quote a conversion rate ourselves.
            </span>
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
              className="h-10 sm:h-9"
              disabled={submitting || currencies.length === 0}
            >
              {submitting ? <Spinner size="sm" label="Creating" /> : null}
              Create deposit address
            </Button>
          </div>
        </form>

        {selected ? (
          <DepositPanel
            deposit={selected}
            refreshing={refreshing}
            onRefresh={() => void refreshDeposit(selected.id)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface DepositHistoryProps {
  items: DepositDTO[];
}

export function DepositHistory({ items }: DepositHistoryProps) {
  const columns = React.useMemo<DataTableColumn<DepositDTO>[]>(
    () => [
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (deposit) => <Usd value={deposit.amountUsd} tone="neutral" />,
      },
      {
        key: 'currency',
        header: 'Currency',
        cell: (deposit) => {
          const meta = assetMeta(deposit.cryptoCurrency);
          return (
            <span className="flex flex-col">
              <span className="text-base-100">{meta.symbol}</span>
              <span className="text-xs text-muted">{meta.network}</span>
            </span>
          );
        },
      },
      {
        key: 'payAmount',
        header: 'Pay amount',
        align: 'right',
        cell: (deposit) => (
          <span className="tabular-nums text-base-100">
            {formatPayAmount(deposit.payAmount, deposit.cryptoCurrency)}{' '}
            <span className="text-xs text-muted">{assetMeta(deposit.cryptoCurrency).symbol}</span>
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (deposit) => <StatusBadge status={deposit.status} kind="payment" showIcon />,
      },
      {
        key: 'created',
        header: 'Created',
        align: 'right',
        cell: (deposit) => (
          <time dateTime={deposit.createdAt} suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(deposit.createdAt)}
          </time>
        ),
      },
      {
        key: 'updated',
        header: 'Updated',
        align: 'right',
        cell: (deposit) => (
          <time dateTime={deposit.updatedAt} suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(deposit.updatedAt)}
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
          Deposit history
        </h2>
        <p className="mt-1 text-sm text-muted">
          Every payment the provider issued for this account, newest first.
        </p>
      </div>
      <DataTable<DepositDTO>
        columns={columns}
        rows={items}
        getRowKey={(deposit) => deposit.id}
        emptyState={
          <EmptyState
            size="sm"
            title="No deposits yet"
            description="A deposit appears here as soon as the provider issues an address for it."
          />
        }
      />
    </div>
  );
}
