'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Ban,
  KeyRound,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { LiveDot, type LiveDotState } from '@/components/shared/live-dot';
import { Usd } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { LatencyProbeCell } from '@/components/admin/latency-probe';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import type {
  BrokerRemovalResult,
  BrokerSyncResult,
  SyncSummaryView,
} from '@/components/admin/types';
import { cn, relativeTime } from '@/lib/utils';
import type { BrokerConnectionDTO } from '@/types/api';

type Environment = 'LIVE' | 'DEMO';

interface AddFormState {
  metaApiAccountId: string;
  brokerName: string;
  environment: Environment;
  token: string;
}

interface SyncReport {
  connectionId: string;
  brokerName: string;
  summary: SyncSummaryView;
}

function emptyForm(): AddFormState {
  return { metaApiAccountId: '', brokerName: '', environment: 'DEMO', token: '' };
}

function liveStateFor(status: string): LiveDotState {
  switch (status.toUpperCase()) {
    case 'CONNECTED':
    case 'DEPLOYED':
      return 'connected';
    case 'CONNECTING':
      return 'connecting';
    case 'ERROR':
      return 'error';
    case 'DISCONNECTED':
    case 'UNDEPLOYED':
      return 'disconnected';
    default:
      return 'paused';
  }
}

export interface BrokerManagerProps {
  initialConnections: BrokerConnectionDTO[];
  /** Registering, syncing and deleting connections is ADMIN-only in the API. */
  canManage: boolean;
}

/**
 * Broker connection manager (Deriv).
 *
 * The Deriv API token is the platform's most sensitive credential. This component:
 *   - keeps it only in React state for the duration of the form,
 *   - renders it with `type="password"` and never reads it back from anywhere,
 *   - never logs it, never puts it in a toast, never writes it to localStorage,
 *     sessionStorage or the URL,
 *   - clears it as soon as the dialog closes or the request finishes.
 * The server encrypts it (AES-256-GCM) before storage and never returns it.
 */
export function BrokerManager({ initialConnections, canManage }: BrokerManagerProps) {
  const router = useRouter();

  const [connections, setConnections] = React.useState<BrokerConnectionDTO[]>(initialConnections);
  const [reloading, setReloading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  const [addOpen, setAddOpen] = React.useState(false);
  const [form, setForm] = React.useState<AddFormState>(emptyForm);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const [deleteTarget, setDeleteTarget] = React.useState<BrokerConnectionDTO | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const [syncingId, setSyncingId] = React.useState<string | null>(null);
  const [syncReport, setSyncReport] = React.useState<SyncReport | null>(null);

  const load = React.useCallback(async () => {
    setReloading(true);
    setListError(null);
    try {
      const data = await adminRequest<BrokerConnectionDTO[]>('/api/v1/admin/brokers');
      setConnections(data);
    } catch (caught) {
      setListError(errorMessage(caught));
    } finally {
      setReloading(false);
    }
  }, []);

  const closeAddDialog = () => {
    setAddOpen(false);
    setForm(emptyForm());
    setFormError(null);
  };

  const submitAdd = async () => {
    if (form.metaApiAccountId.trim() === '' || form.brokerName.trim() === '' || form.token.trim() === '') {
      setFormError('Account id, broker name and Deriv API token are all required.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      // The token is sent once, in this request body, over the same-origin TLS
      // connection. `adminRequest` never logs a body.
      const created = await adminRequest<BrokerConnectionDTO>('/api/v1/admin/brokers', {
        method: 'POST',
        body: {
          metaApiAccountId: form.metaApiAccountId.trim(),
          brokerName: form.brokerName.trim(),
          environment: form.environment,
          token: form.token,
        },
      });

      toast({
        variant: 'success',
        title: 'Connection registered',
        description:
          `${created.brokerName} · ${created.maskedAccount} · ${created.environment}. ` +
          'The account snapshot was read live before the row was written; the token is encrypted at rest and never returned.',
      });

      closeAddDialog();
      await load();
      router.refresh();
    } catch (caught) {
      // Deliberately only the message: nothing derived from the token body.
      setFormError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const runSync = React.useCallback(
    async (connection: BrokerConnectionDTO) => {
      setSyncingId(connection.id);
      try {
        const result = await adminRequest<BrokerSyncResult>(
          `/api/v1/admin/brokers/${encodeURIComponent(connection.id)}/status`,
          { method: 'POST' },
        );
        setSyncReport({
          connectionId: connection.id,
          brokerName: connection.brokerName,
          summary: result.summary,
        });
        toast({
          variant: result.summary.errors > 0 ? 'warn' : 'success',
          title: 'Sync cycle completed',
          description:
            `${result.summary.positions} positions · ${result.summary.deals} deals · ` +
            `${result.summary.unattributed} unattributed · ${result.summary.errors} errors.`,
        });
        await load();
        router.refresh();
      } catch (caught) {
        toast({ variant: 'danger', title: 'Sync failed', description: errorMessage(caught) });
      } finally {
        setSyncingId(null);
      }
    },
    [load, router],
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await adminRequest<BrokerRemovalResult>(
        `/api/v1/admin/brokers/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' },
      );
      toast({
        variant: 'info',
        title: result.removed ? 'Connection deleted' : 'Connection disconnected',
        description: result.removed
          ? `${deleteTarget.brokerName} had no trade history, so the row was deleted. Its encrypted token was deleted as well.`
          : `${deleteTarget.brokerName} has trade history, so the row was kept as DISCONNECTED (archived trades still reference a real broker record). Its encrypted token was deleted.`,
      });
      setDeleteTarget(null);
      await load();
      router.refresh();
    } catch (caught) {
      toast({ variant: 'danger', title: 'Could not remove the connection', description: errorMessage(caught) });
    } finally {
      setDeleting(false);
    }
  };

  const columns = React.useMemo<DataTableColumn<BrokerConnectionDTO>[]>(
    () => [
      {
        key: 'broker',
        header: 'Broker',
        cell: (connection) => (
          <div className="flex flex-col">
            <span className="text-sm font-medium text-base-100">{connection.brokerName}</span>
            <span className="font-mono text-xs text-muted">{connection.maskedAccount}</span>
          </div>
        ),
      },
      {
        key: 'environment',
        header: 'Environment',
        cell: (connection) =>
          connection.environment.toUpperCase() === 'LIVE' ? (
            <Badge variant="danger" title="Live trading account — real money">
              LIVE
            </Badge>
          ) : (
            <Badge variant="brand">DEMO</Badge>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (connection) => (
          <div className="flex flex-col gap-1">
            <StatusBadge status={connection.status} kind="broker" showIcon />
            <LiveDot state={liveStateFor(connection.status)} size="sm" />
          </div>
        ),
      },
      {
        key: 'balance',
        header: 'Balance',
        align: 'right',
        cell: (connection) =>
          connection.balance === null ? (
            <span className="text-muted" title="The broker did not report this figure.">
              —
            </span>
          ) : (
            <Usd value={connection.balance} tone="neutral" className="text-sm" />
          ),
      },
      {
        key: 'equity',
        header: 'Equity',
        align: 'right',
        cell: (connection) =>
          connection.equity === null ? (
            <span className="text-muted" title="The broker did not report this figure.">
              —
            </span>
          ) : (
            <Usd value={connection.equity} tone="neutral" className="text-sm" />
          ),
      },
      {
        key: 'freeMargin',
        header: 'Free margin',
        align: 'right',
        cell: (connection) =>
          connection.freeMargin === null ? (
            <span className="text-muted" title="The broker did not report this figure.">
              —
            </span>
          ) : (
            <Usd value={connection.freeMargin} tone="neutral" className="text-sm" />
          ),
      },
      {
        key: 'updated',
        header: 'Last update',
        cell: (connection) => (
          <span suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(connection.updatedAt)}
          </span>
        ),
      },
      {
        key: 'latency',
        header: 'Latency',
        cell: (connection) => (
          <LatencyProbeCell
            connectionId={connection.id}
            initialLatencyMs={connection.latencyMs}
            brokerName={connection.brokerName}
          />
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        cell: (connection) =>
          canManage ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runSync(connection)}
                disabled={syncingId !== null}
              >
                <RotateCw aria-hidden className={cn(syncingId === connection.id && 'animate-spin')} />
                {syncingId === connection.id ? 'Syncing…' : 'Run sync now'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(connection)}
                aria-label={`Remove ${connection.brokerName}`}
              >
                <Trash2 aria-hidden className="text-loss-400" />
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted">ADMIN only</span>
          ),
      },
    ],
    [canManage, syncingId, runSync],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">
          Balances, equity and free margin are the last broker-reported values, refreshed whenever a
          sync cycle runs. Latency is measured only on request — a dash means “not probed”, never a
          placeholder.
        </p>
        <div className="flex items-center gap-2">
          {reloading ? <Spinner size="sm" label="Refreshing connections" /> : null}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={reloading}>
            <RefreshCw aria-hidden className={cn(reloading && 'animate-spin')} />
            Refresh
          </Button>
          {canManage ? (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden />
              Add connection
            </Button>
          ) : null}
        </div>
      </div>

      {listError ? (
        <Alert variant="danger">
          <AlertTitle>Could not load connections</AlertTitle>
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      {syncReport ? (
        <Alert variant={syncReport.summary.errors > 0 ? 'warn' : 'success'}>
          <AlertTitle>Last sync — {syncReport.brokerName}</AlertTitle>
          <AlertDescription>
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              <span>positions processed: {syncReport.summary.positions}</span>
              <span>deals seen: {syncReport.summary.deals}</span>
              <span>unattributed: {syncReport.summary.unattributed}</span>
              <span>errors: {syncReport.summary.errors}</span>
              <span>investments rolled up: {syncReport.summary.investmentsUpdated}</span>
            </span>
            <span className="mt-1 block">
              Unattributed rows are positions or deals that could not be tied to a known investment;
              they are reported here rather than silently attributed.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <DataTable<BrokerConnectionDTO>
        columns={columns}
        rows={connections}
        getRowKey={(connection) => connection.id}
        isLoading={reloading && connections.length === 0}
        skeletonRows={3}
        emptyState={
          <EmptyState
            icon={Plug}
            title="No broker connection registered"
            description="Until a Deriv account is connected there is no broker balance, equity or exposure to report — and nothing on this platform invents one."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <Plus aria-hidden />
                  Add connection
                </Button>
              ) : null
            }
          />
        }
      />

      <Alert variant="info" icon={ShieldCheck}>
        <AlertTitle>How the Deriv API token is handled</AlertTitle>
        <AlertDescription>
          The token is sent once, encrypted server-side (AES-256-GCM) before it is stored, and never
          returned by any API response. The browser keeps it only in this form&apos;s state: it is
          never written to localStorage or sessionStorage, never placed in the URL, and never logged.
          The connection is only persisted after a live account probe succeeds, so a bad token leaves
          no half-registered row behind.
        </AlertDescription>
      </Alert>

      {/* Add connection */}
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!next && !submitting) closeAddDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plug aria-hidden className="size-4 text-brand-400" />
              Add Deriv connection
            </DialogTitle>
            <DialogDescription>
              Register the trading account this platform may execute on. The account is probed live
              before anything is saved.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="broker-account-id">Deriv account id (loginid)</Label>
              <Input
                id="broker-account-id"
                value={form.metaApiAccountId}
                onChange={(event) => setForm({ ...form, metaApiAccountId: event.target.value })}
                placeholder="e.g. 9f2c1d6e-…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="broker-name">Broker name</Label>
              <Input
                id="broker-name"
                value={form.brokerName}
                onChange={(event) => setForm({ ...form, brokerName: event.target.value })}
                placeholder="e.g. ICMarkets"
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="broker-environment">Environment</Label>
              <Select
                value={form.environment}
                onValueChange={(value) => setForm({ ...form, environment: value as Environment })}
              >
                <SelectTrigger id="broker-environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEMO">DEMO — paper trading</SelectItem>
                  <SelectItem value="LIVE">LIVE — real funds</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="broker-token" className="flex items-center gap-2">
                <KeyRound aria-hidden className="size-3.5 text-muted" />
                Deriv API token
              </Label>
              <Input
                id="broker-token"
                type="password"
                value={form.token}
                onChange={(event) => setForm({ ...form, token: event.target.value })}
                placeholder="Paste the account token"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
              />
              <p className="text-xs leading-relaxed text-muted">
                Encrypted server-side before storage and never returned by the API or written to the
                audit trail. It stays in this form&apos;s memory only — not in localStorage, not in
                the URL, not in a log.
              </p>
            </div>

            {formError ? (
              <Alert variant="danger">
                <AlertTitle>Connection not registered</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Separator />

          <DialogFooter>
            <Button variant="outline" onClick={closeAddDialog} disabled={submitting}>
              <Ban aria-hidden />
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submitAdd()} disabled={submitting}>
              {submitting ? 'Registering…' : 'Register connection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 aria-hidden className="size-4 text-loss-400" />
              Remove {deleteTarget?.brokerName}?
            </DialogTitle>
            <DialogDescription>
              The encrypted token is deleted immediately. If the connection has trade records it is
              kept as DISCONNECTED so archived trades still reference a real broker; otherwise the
              row is deleted outright. Either way the broker stops being synchronised, and the
              removal is audited as BROKER_DISCONNECTED.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? 'Removing…' : 'Remove connection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default BrokerManager;
