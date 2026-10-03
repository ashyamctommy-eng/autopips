'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpFromLine, Ban, CheckCheck, RefreshCw, TriangleAlert, Wallet } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { Usd } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import type { WithdrawalRowView } from '@/components/admin/types';
import { assetMeta, PAYMENT_STATUS_META } from '@/lib/contracts';
import { relativeTime, truncateMiddle } from '@/lib/utils';

export interface WithdrawalDecisionsProps {
  /** Already sorted non-FINISHED first by the page. */
  initialItems: WithdrawalRowView[];
  /** APPROVE/REJECT is ADMIN-only in the API. */
  canDecide: boolean;
}

/** Non-FINISHED first (oldest first), settled history last. Mirrors the server sort. */
function sortQueue(rows: WithdrawalRowView[]): WithdrawalRowView[] {
  return [...rows].sort((a, b) => {
    const aOpen = a.status !== 'FINISHED' && a.status !== 'REFUNDED';
    const bOpen = b.status !== 'FINISHED' && b.status !== 'REFUNDED';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return aOpen ? aTime - bTime : bTime - aTime;
  });
}

/**
 * Payout queue and decisions.
 *
 * Money leaves the platform from this screen, so the copy is explicit about what
 * each outcome means:
 *   - APPROVE moves the request out of PENDING. When the payout provider is
 *     configured the broadcast happens immediately; when it is not, the funds
 *     stay approved pending a manual settlement and the operator records the tx
 *     hash afterwards. The UI never claims a payout that did not happen.
 *   - REJECT requires a reason, which is written to the WITHDRAWAL_REJECTED entry
 *     and shown to the client.
 * A withdrawal approved but not yet settled is stored as SENDING (the payment
 * enum has no APPROVED member), which is why the status badge says "Sending".
 */
export function WithdrawalDecisions({ initialItems, canDecide }: WithdrawalDecisionsProps) {
  const router = useRouter();

  const [rows, setRows] = React.useState<WithdrawalRowView[]>(() => sortQueue(initialItems));

  const [approveTarget, setApproveTarget] = React.useState<WithdrawalRowView | null>(null);
  const [txHash, setTxHash] = React.useState('');
  const [approveError, setApproveError] = React.useState<string | null>(null);
  const [approving, setApproving] = React.useState(false);

  const [rejectTarget, setRejectTarget] = React.useState<WithdrawalRowView | null>(null);
  const [reason, setReason] = React.useState('');
  const [rejectError, setRejectError] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);

  // The queue is re-rendered by the server after every decision (`router.refresh()`),
  // which is also what re-joins the client identity: `WithdrawalDTO` deliberately
  // carries no user, so the page adds the email address server-side. Re-reading the
  // list from the browser instead would lose it, so the local rows simply follow the
  // server's latest props.
  React.useEffect(() => {
    setRows(sortQueue(initialItems));
  }, [initialItems]);

  const submitApprove = async () => {
    if (!approveTarget) return;
    const trimmed = txHash.trim();
    if (trimmed !== '' && trimmed.length < 8) {
      setApproveError('A transaction hash must be at least 8 characters. Leave it empty if you have not settled yet.');
      return;
    }

    setApproving(true);
    setApproveError(null);
    try {
      const updated = await adminRequest<WithdrawalRowView>(
        `/api/v1/admin/withdrawals/${encodeURIComponent(approveTarget.id)}/decision`,
        {
          method: 'POST',
          body: { decision: 'APPROVE', txHash: trimmed === '' ? null : trimmed },
        },
      );

      if (updated.status === 'FINISHED') {
        toast({
          variant: 'success',
          title: 'Settled',
          description: `$${updated.amountUsd.toFixed(2)} ${updated.cryptoCurrency.toUpperCase()} marked FINISHED${
            updated.txHash ? ' with the recorded transaction hash' : ''
          }. Audited as WITHDRAWAL_BROADCAST.`,
        });
      } else {
        toast({
          variant: 'warn',
          title: 'Approved — settlement still pending',
          description:
            'The payout API is not configured, so no broadcast was attempted. The funds remain approved awaiting a manual settlement from the treasury wallet; record the transaction hash once you have paid, and the row will move to FINISHED.',
        });
      }

      setApproveTarget(null);
      setTxHash('');
      router.refresh();
    } catch (caught) {
      setApproveError(errorMessage(caught));
    } finally {
      setApproving(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setRejectError('A rejection reason is required — it is recorded and shown to the client.');
      return;
    }

    setRejecting(true);
    setRejectError(null);
    try {
      await adminRequest<WithdrawalRowView>(
        `/api/v1/admin/withdrawals/${encodeURIComponent(rejectTarget.id)}/decision`,
        { method: 'POST', body: { decision: 'REJECT', reason: trimmed } },
      );
      toast({
        variant: 'warn',
        title: 'Withdrawal rejected',
        description:
          'The request is marked FAILED (the payment enum has no REJECTED member) and the reason was written to the WITHDRAWAL_REJECTED audit entry.',
      });
      setRejectTarget(null);
      setReason('');
      router.refresh();
    } catch (caught) {
      setRejectError(errorMessage(caught));
    } finally {
      setRejecting(false);
    }
  };

  const columns = React.useMemo<DataTableColumn<WithdrawalRowView>[]>(
    () => [
      {
        key: 'client',
        header: 'Client',
        cell: (row) => (
          <div className="flex flex-col">
            <span className="text-sm text-base-100">{row.userEmail ?? 'unknown account'}</span>
            <span className="font-mono text-xs text-muted">{row.id}</span>
          </div>
        ),
      },
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (row) => <Usd value={row.amountUsd} tone="neutral" className="text-sm" />,
      },
      {
        key: 'currency',
        header: 'Asset',
        cell: (row) => {
          const meta = assetMeta(row.cryptoCurrency);
          return (
            <div className="flex flex-col">
              <span className="text-sm text-base-100">{meta.symbol}</span>
              <span className="text-xs text-muted">{meta.network}</span>
            </div>
          );
        },
      },
      {
        key: 'address',
        header: 'Payout address',
        cell: (row) => (
          <span className="font-mono text-xs text-muted" title={row.payoutAddress}>
            {truncateMiddle(row.payoutAddress, 10, 6)}
          </span>
        ),
      },
      {
        key: 'fee',
        header: 'Fee',
        align: 'right',
        cell: (row) => <Usd value={row.feeUsd} tone="neutral" className="text-xs text-muted" />,
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <StatusBadge status={row.status} kind="payment" showIcon />
            {row.status === 'SENDING' ? (
              <span className="text-[0.68rem] text-muted">approved — awaiting settlement</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'txHash',
        header: 'Tx hash',
        cell: (row) =>
          row.txHash ? (
            <span className="font-mono text-xs text-muted" title={row.txHash}>
              {truncateMiddle(row.txHash, 8, 6)}
            </span>
          ) : (
            <span className="text-xs text-muted">—</span>
          ),
      },
      {
        key: 'requested',
        header: 'Requested',
        cell: (row) => (
          <span suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(row.createdAt)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        cell: (row) => {
          if (!canDecide) {
            return <span className="text-xs text-muted">ADMIN only</span>;
          }
          const decidable = row.status === 'PENDING';
          return (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!decidable}
                title={
                  decidable
                    ? 'Record a manual settlement for this request'
                    : `Only a PENDING request can be rejected (current status: ${row.status})`
                }
                onClick={() => {
                  setRejectError(null);
                  setReason('');
                  setRejectTarget(row);
                }}
              >
                <Ban aria-hidden />
                Reject
              </Button>
              <Button
                variant="success"
                size="sm"
                disabled={!(row.status === 'PENDING' || row.status === 'SENDING')}
                onClick={() => {
                  setApproveError(null);
                  setTxHash('');
                  setApproveTarget(row);
                }}
              >
                <CheckCheck aria-hidden />
                {row.status === 'SENDING' ? 'Record settlement' : 'Approve'}
              </Button>
            </div>
          );
        },
      },
    ],
    [canDecide],
  );

  const pendingCount = rows.filter((row) => row.status === 'PENDING').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">
          {pendingCount} request{pendingCount === 1 ? '' : 's'} awaiting a decision. Approving moves
          money: it is the single human gate that lets funds leave the platform, and every decision is
          audited with your admin id.
        </p>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          <RefreshCw aria-hidden />
          Refresh
        </Button>
      </div>

      <DataTable<WithdrawalRowView>
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        skeletonRows={5}
        caption="Unsettled requests first (oldest first), settled history below. Fee is the amount actually charged — 0.00 today, recorded honestly rather than left blank."
        emptyState={
          <EmptyState
            icon={ArrowUpFromLine}
            title="No withdrawal requests"
            description="Requests appear here as soon as a verified client asks to withdraw. Nothing is queued until then."
          />
        }
      />

      {/* Approve */}
      <Dialog
        open={approveTarget !== null}
        onOpenChange={(next) => {
          if (!next && !approving) setApproveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet aria-hidden className="size-4 text-profit-400" />
              Approve payout
            </DialogTitle>
            <DialogDescription>
              {approveTarget
                ? `${approveTarget.userEmail ?? 'unknown account'} · ${approveTarget.amountUsd.toFixed(2)} ${approveTarget.cryptoCurrency.toUpperCase()} to ${truncateMiddle(approveTarget.payoutAddress, 10, 6)}`
                : null}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <dl className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-base-900/40 text-sm">
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-xs uppercase tracking-wide text-muted">Amount</dt>
                <dd>
                  <Usd value={approveTarget?.amountUsd ?? 0} tone="neutral" />
                </dd>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-xs uppercase tracking-wide text-muted">Fee charged</dt>
                <dd>
                  <Usd value={approveTarget?.feeUsd ?? 0} tone="neutral" />
                </dd>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-xs uppercase tracking-wide text-muted">Network</dt>
                <dd className="text-xs text-base-100">
                  {approveTarget ? assetMeta(approveTarget.cryptoCurrency).network : '—'}
                </dd>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2">
                <dt className="text-xs uppercase tracking-wide text-muted">Payout address</dt>
                <dd className="break-all font-mono text-xs text-base-100">
                  {approveTarget?.payoutAddress ?? '—'}
                </dd>
              </div>
            </dl>

            <Alert variant="warn" icon={TriangleAlert}>
              <AlertTitle>What approving does</AlertTitle>
              <AlertDescription>
                The request leaves PENDING. If the payout provider is configured the transfer is
                broadcast immediately; if it is not, <strong>no payout happens</strong> — the funds
                stay approved pending a manual settlement from the treasury wallet. Nothing here ever
                fabricates a transaction hash. The request is stored as SENDING because the payment
                enum has no APPROVED member.
              </AlertDescription>
            </Alert>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="withdrawal-tx-hash">
                Transaction hash{' '}
                <span className="text-xs font-normal text-muted">
                  (optional — only if you have already settled this payout manually)
                </span>
              </Label>
              <Input
                id="withdrawal-tx-hash"
                value={txHash}
                onChange={(event) => setTxHash(event.target.value)}
                placeholder="Leave empty if settlement has not happened yet"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {approveError ? (
              <Alert variant="danger">
                <AlertTitle>Not approved</AlertTitle>
                <AlertDescription>{approveError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Separator />

          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)} disabled={approving}>
              Cancel
            </Button>
            <Button variant="success" onClick={() => void submitApprove()} disabled={approving}>
              {approving ? 'Recording…' : txHash.trim() === '' ? 'Approve' : 'Approve & mark settled'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(next) => {
          if (!next && !rejecting) setRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban aria-hidden className="size-4 text-loss-400" />
              Reject withdrawal
            </DialogTitle>
            <DialogDescription>
              {rejectTarget
                ? `${rejectTarget.userEmail ?? 'unknown account'} · ${rejectTarget.amountUsd.toFixed(2)} ${rejectTarget.cryptoCurrency.toUpperCase()}`
                : null}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="withdrawal-reason">Reason (required)</Label>
              <Textarea
                id="withdrawal-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. The payout address does not match the address on the verified file."
              />
              <p className="text-xs leading-relaxed text-muted">
                The reason is stored in the WITHDRAWAL_REJECTED audit entry and is what the client
                will be told. No funds move.
              </p>
            </div>

            {rejectError ? (
              <Alert variant="danger">
                <AlertTitle>Not rejected</AlertTitle>
                <AlertDescription>{rejectError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Separator />

          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={rejecting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void submitReject()} disabled={rejecting}>
              {rejecting ? 'Rejecting…' : 'Reject request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default WithdrawalDecisions;
