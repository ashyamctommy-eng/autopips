'use client';

import * as React from 'react';
import { AlertOctagon, Play, ShieldAlert } from 'lucide-react';

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
import { Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/shared/status-badge';
import { toast } from '@/components/ui/use-toast';
import type { SystemStatusPayload } from '@/lib/socket-client';

/**
 * Master control bar (client component).
 *
 * One red button that stops every order on the platform, and one that releases
 * it. Stopping is deliberately heavier than starting:
 *
 *   • a confirmation dialog, because this is the emergency stop;
 *   • a REQUIRED reason (the server enforces it too), because the first question
 *     after a halt is always "why did we stop", and the answer must not live in
 *     someone's memory;
 *   • the dialog spells out what does and does not stop — trading halts, market
 *     data and open positions keep running, nothing is liquidated.
 *
 * The status badge reflects the server's state (`enabled`, `source`), never an
 * optimistic local guess: a kill switch that *looks* engaged while orders still
 * flow is worse than no switch at all.
 */

export interface BotControlBarProps {
  initial: SystemStatusPayload;
}

function statusOf(state: SystemStatusPayload): {
  label: string;
  status: string;
  description: string;
  tone: 'ok' | 'warn' | 'error';
} {
  if (state.source === 'unknown') {
    return {
      label: 'UNKNOWN',
      status: 'ERROR',
      description:
        'The kill-switch state could not be read from Redis or the database. Orders are refused while this is unresolved.',
      tone: 'error',
    };
  }
  if (!state.enabled) {
    return {
      label: state.reason?.includes('kill switch') ? 'PAUSED' : 'PAUSED',
      status: 'PAUSED',
      description: state.reason ?? 'Trading is stopped.',
      tone: 'warn',
    };
  }
  return {
    label: 'ONLINE',
    status: 'CONNECTED',
    description: 'Trading is running. Every order still passes the pre-trade risk gate.',
    tone: 'ok',
  };
}

export function BotControlBar({ initial }: BotControlBarProps) {
  const [state, setState] = React.useState<SystemStatusPayload>(initial);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /** The socket pushes state changes made elsewhere; this keeps the badge true. */
  React.useEffect(() => {
    setState(initial);
  }, [initial]);

  const apply = React.useCallback(async (active: boolean, stopReason?: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/admin/bot/kill-switch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ active, ...(stopReason ? { reason: stopReason } : {}) }),
      });
      const body: unknown = await response.json();
      const envelope = typeof body === 'object' && body !== null ? (body as { ok?: unknown; data?: unknown; error?: unknown }) : null;

      if (!response.ok || envelope?.ok !== true) {
        const message =
          typeof (envelope?.error as { message?: unknown } | undefined)?.message === 'string'
            ? ((envelope?.error as { message: string }).message)
            : `The change was refused (HTTP ${response.status}).`;
        setError(message);
        toast({ title: 'Kill switch unchanged', description: message, variant: 'danger' });
        return;
      }

      setState(envelope.data as SystemStatusPayload);
      setConfirmOpen(false);
      setReason('');
      toast({
        title: active ? 'Trading resumed' : 'Trading stopped',
        description: active
          ? 'New orders are accepted again; the pre-trade risk gate still applies.'
          : 'Every new order is refused platform-wide until this is released.',
        variant: active ? 'success' : 'warn',
      });
    } catch {
      const message = 'The kill switch could not be reached. Nothing was changed.';
      setError(message);
      toast({ title: 'Kill switch unchanged', description: message, variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }, []);

  const view = statusOf(state);

  return (
    <div
      className={
        view.tone === 'error'
          ? 'flex flex-col gap-4 rounded-xl border border-loss/40 bg-loss/[0.06] p-5'
          : view.tone === 'warn'
            ? 'flex flex-col gap-4 rounded-xl border border-warn/40 bg-warn/[0.06] p-5'
            : 'flex flex-col gap-4 rounded-xl border border-line bg-base-850/70 p-5'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ShieldAlert aria-hidden className="size-4 text-brand-400" />
            <h2 className="text-base font-semibold text-base-100">Bot control</h2>
            <StatusBadge status={view.status} kind="auto" showIcon />
            <span className="font-mono text-xs uppercase tracking-wide text-muted">{view.label}</span>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted">{view.description}</p>
          {state.source !== 'unknown' ? (
            <p className="text-xs text-muted">
              state read from <span className="text-base-100">{state.source}</span> · checked{' '}
              {new Date(state.checkedAt).toLocaleTimeString('en-GB')}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {state.enabled ? (
            <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={busy}>
              <AlertOctagon aria-hidden />
              EMERGENCY STOP
            </Button>
          ) : (
            <Button onClick={() => void apply(true)} disabled={busy}>
              {busy ? <Spinner aria-hidden /> : <Play aria-hidden />}
              Resume trading
            </Button>
          )}
        </div>
      </div>

      {error ? <p className="text-xs text-loss-400">{error}</p> : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop all trading?</DialogTitle>
            <DialogDescription>
              Every new order is refused platform-wide, in every process, from the moment you confirm.
              <span className="mt-2 block text-base-100">
                This stops NEW orders. It does not close open positions, does not stop market data, and
                does not touch client balances. Closing a position is a separate, deliberate action.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="kill-switch-reason">Why are you stopping trading?</Label>
            <Input
              id="kill-switch-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. broker incident — verifying fills"
              disabled={busy}
            />
            <p className="text-xs text-muted">
              Kept with the switch state and written to the audit log. Required.
            </p>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void apply(false, reason.trim())}
              disabled={busy || reason.trim().length < 3}
            >
              {busy ? <Spinner aria-hidden /> : <AlertOctagon aria-hidden />}
              Stop trading now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
