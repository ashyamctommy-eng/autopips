'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownToLine, Plus, RefreshCw, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Usd } from '@/components/shared/money';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PaymentStatusValue } from '@/types/api';

/**
 * Deposits (client funds IN).
 *
 * Two jobs:
 *   1. show every deposit the platform has recorded — provider payments and
 *      operator credits alike, visually distinguished;
 *   2. let an ADMIN credit a client's balance by hand, for money that arrived
 *      outside NOWPayments (a bank transfer, a correction, a funded test
 *      account).
 *
 * A manual credit is presented as exactly that at every level: the row is
 * labelled MANUAL, the dialog says no payment is being claimed, and the audit
 * trail records the operator and their reason. Nothing here can make a manual
 * credit look like a settled crypto payment.
 */

export interface DepositRow {
  id: string;
  userEmail: string;
  userName: string;
  amountUsd: number;
  cryptoCurrency: string;
  paymentId: string;
  status: PaymentStatusValue;
  createdAt: string;
}

export interface DepositManagerProps {
  initialItems: DepositRow[];
  /** Manual credits are ADMIN-only (they create money in the ledger). */
  canCredit: boolean;
}

function statusVariant(status: PaymentStatusValue) {
  if (status === 'CONFIRMED' || status === 'FINISHED') return 'success' as const;
  if (status === 'FAILED' || status === 'REFUNDED') return 'danger' as const;
  return 'warn' as const;
}

/** `manual:<uuid>` — written that way so it can never match a provider payment. */
function isManual(paymentId: string): boolean {
  return paymentId.startsWith('manual:');
}

export function DepositManager({ initialItems, canCredit }: DepositManagerProps) {
  const router = useRouter();
  const [items, setItems] = React.useState<DepositRow[]>(initialItems);
  const [reloading, setReloading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  const total = React.useMemo(
    () =>
      items
        .filter((row) => row.status === 'CONFIRMED' || row.status === 'FINISHED')
        .reduce((sum, row) => sum + row.amountUsd, 0),
    [items],
  );

  const reload = React.useCallback(async () => {
    setReloading(true);
    try {
      const data = await adminRequest<{ items: DepositRow[] }>('/api/v1/admin/deposits?take=100');
      setItems(data.items);
      router.refresh();
    } catch (caught) {
      toast({ variant: 'danger', title: 'Could not refresh deposits', description: errorMessage(caught) });
    } finally {
      setReloading(false);
    }
  }, [router]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminRequest('/api/v1/admin/deposits', {
        method: 'POST',
        body: { email: email.trim().toLowerCase(), amount_usd: Number(amount), note: note.trim() },
      });
      toast({
        variant: 'success',
        title: 'Deposit credited',
        description: `${amount} USD credited to ${email.trim().toLowerCase()}.`,
      });
      setOpen(false);
      setEmail('');
      setAmount('');
      setNote('');
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-col gap-3 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ArrowDownToLine aria-hidden className="size-4 text-brand-400" />
            Deposits
          </CardTitle>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {items.length} most recent · {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total)} credited in this view
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={reloading}>
            <RefreshCw aria-hidden className={reloading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          {canCredit ? (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus aria-hidden />
              Credit a deposit
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted">
            No deposits recorded yet. Client deposits appear here the moment the payment provider
            confirms them; an operator credit appears immediately.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-sm text-base-100">
                      <span className="block">{row.userEmail}</span>
                      <span className="text-xs text-muted">{row.userName}</span>
                    </TableCell>
                    <TableCell className="tabular text-sm">
                      <Usd value={row.amountUsd} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {isManual(row.paymentId) ? (
                        <Badge variant="warn">MANUAL</Badge>
                      ) : (
                        <span className="text-muted">{row.cryptoCurrency}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[18rem] truncate font-mono text-xs text-muted">
                      {row.paymentId}
                    </TableCell>
                    <TableCell className="text-xs text-muted">
                      {new Date(row.createdAt).toLocaleString('en-GB')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => (!busy ? setOpen(next) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowDownToLine aria-hidden className="size-4 text-brand-400" />
              Credit a client balance
            </DialogTitle>
            <DialogDescription>
              For money that arrived outside the payment provider — a bank transfer, a correction, or
              a funded test account. No payment is claimed: the row is stored as MANUAL, and the audit
              trail records you and your reason.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="credit-email">Client email</Label>
              <Input
                id="credit-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="client@example.com"
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="credit-amount">Amount (USD)</Label>
              <Input
                id="credit-amount"
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1000.00"
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="credit-note">Reason</Label>
              <Textarea
                id="credit-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. test account funding for the demo broker cycle"
                rows={3}
                disabled={busy}
              />
            </div>

            <Alert variant="warn">
              <TriangleAlert aria-hidden />
              <AlertTitle>This creates real ledger money</AlertTitle>
              <AlertDescription>
                The client&apos;s balance rises the moment you confirm, from the same formula a
                confirmed crypto deposit uses. A staff account cannot be credited here.
                {error ? ` ${error}` : ''}
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={busy || email.trim().length < 3 || !amount || note.trim().length < 3}
            >
              {busy ? 'Crediting…' : 'Credit balance'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
