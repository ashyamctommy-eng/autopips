'use client';

import * as React from 'react';
import { ArrowDownLeft, ArrowUpRight, RefreshCw, Wallet } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { AdminApiError, adminRequest, errorMessage } from '@/components/admin/api-client';
import type { AdminUserRowView } from '@/components/admin/types';
import { cn } from '@/lib/utils';

type AdjustType = 'credit' | 'debit';

interface WalletBalance {
  userId: string;
  balance: string;
}

interface WalletAdjustResult extends WalletBalance {
  adjustmentId: string;
}

export interface WalletAdjustDialogProps {
  /** The user being adjusted; null closes the dialog. */
  user: AdminUserRowView | null;
  /** Bumped by the parent on equity websocket pushes to re-read the balance. */
  refreshSignal?: number;
  onClose: () => void;
  onAdjusted: () => void;
}

const MAX_AMOUNT = 1e12;
const REASON_MIN = 3;
const REASON_MAX = 1000;
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function validateAmount(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter an amount.';
  if (!AMOUNT_PATTERN.test(v)) return 'Use a positive USD amount with at most 2 decimal places.';
  if (Number(v) <= 0) return 'Amount must be greater than zero.';
  if (Number(v) > MAX_AMOUNT) return 'Amount cannot exceed $1,000,000,000,000.';
  return null;
}

/**
 * SUPER_ADMIN-only wallet adjustment.
 *
 * Idempotency: one UUID is minted per distinct submission (user + type + amount +
 * reason). Retrying an unchanged submission after a network failure re-sends the
 * SAME key, so the server can never apply the money movement twice. Editing any
 * field, or a confirmed success, mints a fresh key for the next submission.
 */
export function WalletAdjustDialog({ user, refreshSignal = 0, onClose, onAdjusted }: WalletAdjustDialogProps) {
  const open = user !== null;
  const userId = user?.id ?? null;

  const [balance, setBalance] = React.useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = React.useState(false);
  const [balanceError, setBalanceError] = React.useState<string | null>(null);

  const [type, setType] = React.useState<AdjustType>('credit');
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const keyRef = React.useRef<{ fingerprint: string; key: string } | null>(null);

  const loadBalance = React.useCallback(async (id: string, signal?: AbortSignal) => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const data = await adminRequest<WalletBalance>(`/api/admin/wallets/${encodeURIComponent(id)}`, { signal });
      setBalance(data.balance);
    } catch (caught) {
      if (signal?.aborted) return;
      setBalanceError(errorMessage(caught));
    } finally {
      if (!signal?.aborted) setBalanceLoading(false);
    }
  }, []);

  // Reset the form whenever a different user is opened.
  React.useEffect(() => {
    setType('credit');
    setAmount('');
    setReason('');
    setTouched(false);
    setSubmitError(null);
    setBalance(null);
    keyRef.current = null;
  }, [userId]);

  React.useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void loadBalance(userId, controller.signal);
    return () => controller.abort();
  }, [userId, refreshSignal, loadBalance]);

  const amountError = validateAmount(amount);
  const reasonLength = reason.trim().length;
  const reasonError =
    reasonLength === 0
      ? 'A reason is required for the audit trail.'
      : reasonLength < REASON_MIN
        ? `Reason must be at least ${REASON_MIN} characters.`
        : reasonLength > REASON_MAX
          ? `Reason must be at most ${REASON_MAX} characters.`
          : null;
  const numericAmount = amountError ? null : Number(amount.trim());
  const insufficient =
    type === 'debit' && numericAmount !== null && balance !== null && Number.isFinite(Number(balance)) && numericAmount > Number(balance);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!userId || amountError || reasonError || numericAmount === null || submitting) return;

    const body = { userId, amount: numericAmount, type, reason: reason.trim() };
    const fingerprint = JSON.stringify(body);
    if (!keyRef.current || keyRef.current.fingerprint !== fingerprint) {
      keyRef.current = { fingerprint, key: newUuid() };
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await adminRequest<WalletAdjustResult>('/api/admin/wallets/adjust-balance', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': keyRef.current.key },
      });
      keyRef.current = null;
      setBalance(result.balance);
      setAmount('');
      setReason('');
      setTouched(false);
      toast({
        variant: 'success',
        title: `${type === 'credit' ? 'Credited' : 'Debited'} ${formatUsd(String(numericAmount))}`,
        description: `${user?.email} · new balance ${formatUsd(result.balance)} · ref ${result.adjustmentId}`,
      });
      onAdjusted();
      onClose();
    } catch (caught) {
      // A definitive 4xx refusal means nothing was applied; network/5xx keeps the key for a safe retry.
      if (caught instanceof AdminApiError && caught.status >= 400 && caught.status < 500 && caught.status !== 409) {
        keyRef.current = null;
      }
      setSubmitError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet aria-hidden className="size-4 text-brand-400" />
              Adjust User Wallet Balance
            </DialogTitle>
            <DialogDescription>
              {user ? `${user.fullName} · ${user.email}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between rounded-lg border border-line bg-base-850/60 px-4 py-3" aria-live="polite">
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-muted">Current available balance</span>
              {balanceLoading && balance === null ? (
                <span className="mt-1 h-6 w-28 animate-pulse rounded bg-base-800" aria-label="Loading balance" />
              ) : (
                <span className="mt-0.5 text-lg font-medium tabular-nums text-base-100">{formatUsd(balance)}</span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => userId && void loadBalance(userId)}
              disabled={balanceLoading || !userId}
              aria-label="Refresh balance"
            >
              <RefreshCw aria-hidden className={cn(balanceLoading && 'animate-spin')} />
            </Button>
          </div>
          {balanceError ? (
            <Alert variant="danger">
              <AlertTitle>Could not load balance</AlertTitle>
              <AlertDescription>{balanceError}</AlertDescription>
            </Alert>
          ) : null}

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-base-100">Adjustment type</legend>
            <div role="radiogroup" aria-label="Adjustment type" className="grid grid-cols-2 gap-2">
              {(['credit', 'debit'] as const).map((option) => {
                const active = type === option;
                const Icon = option === 'credit' ? ArrowDownLeft : ArrowUpRight;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setType(option)}
                    disabled={submitting}
                    className={cn(
                      'inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                      active
                        ? option === 'credit'
                          ? 'border-profit-500/60 bg-profit-500/10 text-profit-400'
                          : 'border-loss-500/60 bg-loss-500/10 text-loss-400'
                        : 'border-line bg-base-800/60 text-muted hover:text-base-100',
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {option === 'credit' ? 'Credit' : 'Debit'}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wallet-amount">Amount (USD)</Label>
            <Input
              id="wallet-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
              aria-invalid={touched && !!amountError}
              aria-describedby="wallet-amount-hint"
            />
            <p id="wallet-amount-hint" className={cn('text-xs', touched && amountError ? 'text-loss-400' : 'text-muted')}>
              {touched && amountError ? amountError : 'Positive amount, up to 2 decimal places.'}
            </p>
            {insufficient ? (
              <p className="text-xs text-warn-400">This debit exceeds the current available balance; the server may refuse it.</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wallet-reason">Reason</Label>
            <Textarea
              id="wallet-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              required
              maxLength={REASON_MAX}
              aria-invalid={touched && !!reasonError}
              aria-describedby="wallet-reason-hint"
              placeholder="e.g. Goodwill credit for ticket #4821"
            />
            <p id="wallet-reason-hint" className={cn('text-xs', touched && reasonError ? 'text-loss-400' : 'text-muted')}>
              {touched && reasonError ? reasonError : `Recorded in the audit log with your account. ${reasonLength}/${REASON_MAX}`}
            </p>
          </div>

          {submitError ? (
            <Alert variant="danger" role="alert">
              <AlertTitle>Balance not adjusted</AlertTitle>
              <AlertDescription>
                {submitError} Retrying without changes reuses the same request key, so it cannot be applied twice.
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !userId}>
              {submitting ? 'Applying…' : submitError ? 'Retry' : type === 'credit' ? 'Credit wallet' : 'Debit wallet'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default WalletAdjustDialog;
