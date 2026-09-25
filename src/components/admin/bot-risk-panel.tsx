'use client';

import * as React from 'react';
import { Save, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/use-toast';
import type { SystemStatusPayload } from '@/lib/socket-client';

/**
 * Risk configuration panel (client component).
 *
 * Two things an operator can change without a redeploy, both enforced where
 * they matter: the numeric limits in the order path (a stake cap is checked when
 * an order is priced — the only moment a stake exists), and the symbol allow-list
 * in the pre-trade gate.
 *
 * THE ALLOW-LIST HAS TWO MODES, and the distinction is a real decision:
 *   • "all symbols"    — the setting row is cleared. This is the default.
 *   • "only selected"  — the setting row holds an explicit list.
 * An EMPTY list means "no restriction", so a mode that meant "restrict to
 * nothing" would be indistinguishable from "allow everything" — that state is
 * what the kill switch is for, and this panel will not fake it: saving with
 * nothing selected is refused.
 *
 * Every limit of 0 means "no limit", and the panel says so rather than hiding it.
 */

export interface BotInstrument {
  symbol: string;
  displayName: string;
  market: string;
  isTradable: boolean;
}

export interface BotRiskPanelProps {
  initial: SystemStatusPayload;
  instruments: BotInstrument[];
  instrumentsError: string | null;
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

export function BotRiskPanel({ initial, instruments, instrumentsError }: BotRiskPanelProps) {
  const [state, setState] = React.useState<SystemStatusPayload>(initial);
  const [maxStake, setMaxStake] = React.useState(String(initial.maxStakeUsd));
  const [dailyLoss, setDailyLoss] = React.useState(String(initial.dailyLossLimitUsd));
  const [minPayout, setMinPayout] = React.useState(String(initial.minPayoutPercentage));
  const [riskPerTrade, setRiskPerTrade] = React.useState(String(initial.riskPerTradePct));
  const [restrictSymbols, setRestrictSymbols] = React.useState(initial.allowedSymbols.length > 0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(initial.allowedSymbols));
  const [search, setSearch] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setState(initial);
  }, [initial]);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toUpperCase();
    const rows = needle
      ? instruments.filter(
          (instrument) =>
            instrument.symbol.toUpperCase().includes(needle) ||
            instrument.displayName.toUpperCase().includes(needle),
        )
      : instruments;
    return rows.slice(0, 60);
  }, [instruments, search]);

  const toggleSymbol = React.useCallback((symbol: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }, []);

  const saveBlockedBySymbols = restrictSymbols && selected.size === 0;

  const save = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/admin/bot/config', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          max_stake_limit: Number(maxStake) || 0,
          daily_loss_limit: Number(dailyLoss) || 0,
          min_payout_percentage: Number(minPayout) || 0,
          risk_per_trade_pct: Number(riskPerTrade) || 0,
          allowed_symbols: restrictSymbols ? Array.from(selected) : [],
        }),
      });
      const body: unknown = await response.json();
      const envelope =
        typeof body === 'object' && body !== null
          ? (body as { ok?: unknown; data?: unknown })
          : null;

      if (!response.ok || envelope?.ok !== true) {
        const message = errorMessage(body, `The change was refused (HTTP ${response.status}).`);
        toast({ title: 'Risk config not saved', description: message, variant: 'danger' });
        return;
      }

      const next = envelope.data as SystemStatusPayload;
      setState(next);
      toast({
        title: 'Risk config saved',
        description: 'The bot enforces the new limits on the next order — no restart needed.',
        variant: 'success',
      });
    } catch {
      toast({
        title: 'Risk config not saved',
        description: 'The request could not be completed. Nothing was changed.',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }, [dailyLoss, maxStake, minPayout, riskPerTrade, restrictSymbols, selected]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
        <CardTitle>Risk configuration</CardTitle>
        <div className="flex items-center gap-2">
          {state.allowedSymbols.length === 0 ? (
            <Badge variant="outline">All symbols allowed</Badge>
          ) : (
            <Badge variant="warn">{state.allowedSymbols.length} symbols allowed</Badge>
          )}
          <Button size="sm" onClick={() => void save()} disabled={busy || saveBlockedBySymbols}>
            {busy ? <Spinner aria-hidden /> : <Save aria-hidden />}
            Save
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-6 p-5 pt-2">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="max-stake">Maximum stake per order (USD)</Label>
            <Input
              id="max-stake"
              type="number"
              min={0}
              step="0.01"
              value={maxStake}
              onChange={(event) => setMaxStake(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted">0 = no cap.</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="daily-loss">Daily realised-loss limit (USD)</Label>
            <Input
              id="daily-loss"
              type="number"
              min={0}
              step="0.01"
              value={dailyLoss}
              onChange={(event) => setDailyLoss(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted">New orders stop at −this amount for the UTC day. 0 = no limit.</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="min-payout">Minimum payout (%)</Label>
            <Input
              id="min-payout"
              type="number"
              min={0}
              step="0.1"
              value={minPayout}
              onChange={(event) => setMinPayout(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted">
              0 = no floor. A contract type that quotes no payout is refused while a floor is set.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="risk-per-trade">Risk per trade (% of capital)</Label>
            <Input
              id="risk-per-trade"
              type="number"
              min={0}
              step="0.1"
              value={riskPerTrade}
              onChange={(event) => setRiskPerTrade(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs leading-relaxed text-muted">
              How much of an investment&apos;s capital one contract may put at risk. On a Deriv
              multiplier the stake <em>is</em> the maximum loss, so this is the loss budget for a
              single order — the exposure it opens (stake × multiplier) is derived from it, not the
              other way round. 0 refuses every stake-sized order.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Switch
                id="restrict-symbols"
                checked={restrictSymbols}
                onCheckedChange={(checked) => {
                  setRestrictSymbols(checked);
                  if (!checked) setSelected(new Set());
                }}
                disabled={busy}
              />
              <Label htmlFor="restrict-symbols">
                Trade only selected symbols
                <span className="ml-2 text-xs font-normal text-muted">
                  off = every symbol the broker offers
                </span>
              </Label>
            </div>

            {restrictSymbols ? (
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter markets"
                  className="pl-8"
                  disabled={busy}
                />
              </div>
            ) : null}
          </div>

          {!restrictSymbols ? null : instrumentsError ? (
            <p className="text-xs text-warn-400">
              The broker could not list instruments ({instrumentsError}), so there is nothing to select.
              The allow-list currently holds {state.allowedSymbols.length} symbol
              {state.allowedSymbols.length === 1 ? '' : 's'}.
            </p>
          ) : instruments.length === 0 ? (
            <p className="text-xs text-muted">
              The broker returned no instruments. Market data may not be connected yet.
            </p>
          ) : (
            <ul className="grid max-h-72 gap-2 overflow-y-auto rounded-lg border border-line bg-base-900/40 p-3 sm:grid-cols-2">
              {filtered.map((instrument) => (
                <li key={instrument.symbol} className="flex items-center gap-3">
                  <input
                    id={`symbol-${instrument.symbol}`}
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={selected.has(instrument.symbol)}
                    onChange={() => toggleSymbol(instrument.symbol)}
                    disabled={busy}
                  />
                  <label htmlFor={`symbol-${instrument.symbol}`} className="flex flex-1 flex-col">
                    <span className="font-mono text-xs text-base-100">{instrument.symbol}</span>
                    <span className="text-[0.7rem] text-muted">{instrument.displayName}</span>
                  </label>
                  {instrument.isTradable ? null : <Badge variant="outline">closed</Badge>}
                </li>
              ))}
            </ul>
          )}

          {saveBlockedBySymbols ? (
            <p className="text-xs text-warn-400">
              Select at least one symbol, or switch back to “every symbol”. An empty allow-list means no
              restriction, so saving it empty would mean the opposite of what this panel shows — use the
              kill switch to stop trading entirely.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
