'use client';

import * as React from 'react';
import { useRouter } from '@/lib/next/navigation';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { formatUsd } from '@/lib/money';
import { apiFetch } from '@/lib/session-refresh';
import {
  exposureNotional,
  isTicketValid,
  TICKET_LIMITS,
  validateTicket,
  type TicketSide,
} from '@/lib/order-ticket';

/**
 * Order ticket (client component).
 *
 * Opens an INTERNAL position through `POST /api/v1/positions`, which reserves the
 * stake out of withdrawable cash and books it as deployed capital. Three things
 * about that are deliberate and visible here:
 *
 *  1. THE STAKE IS THE MAXIMUM LOSS. The multiplier scales the exposure and how
 *     fast the P/L moves, never the money at risk, so the ticket states the stake
 *     as the money at risk and shows the notional beside it as a separate figure.
 *  2. THE FILL IS THE SERVER'S. There is no entry price in the request — the
 *     server prices it from the market feed. This form never sends a price.
 *  3. THE ORDER IS CONFIRMED BEFORE IT IS SENT. Clicking BUY or SELL opens a
 *     summary of what is about to be committed; only the dialog's button submits.
 *     One click on a phone should not move money.
 *
 * Everything is re-validated server-side (limits, KYC, balance, execution mode);
 * `@/lib/order-ticket` only says the same things earlier, in the same words.
 */

/** Prices are shown at broker precision. */
const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

const MULTIPLIER_OPTIONS = [1, 5, 10, 25, 50, 100] as const;

interface QuoteView {
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

export interface OrderTicketProps {
  /** Instrument the ticket trades; null disables it. */
  symbol: string | null;
  /** Live quote for that instrument, or null before the first tick. */
  quote: QuoteView | null;
  /**
   * The order ticket no longer requires an approved identity check: KYC is
   * enforced on withdrawals only. Trading is available from a signed-in session.
   */
  /** Ledger withdrawable cash, or null when it could not be read. */
  availableUsd: number | null;
}

function envelopeError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return null;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : null;
}

/** Entry price the server reported, or null — never a client-side estimate. */
function openedEntryPrice(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const price = (data as { entryPrice?: unknown }).entryPrice;
  return typeof price === 'number' && Number.isFinite(price) ? price : null;
}

export function OrderTicket({ symbol, quote, availableUsd }: OrderTicketProps) {
  const router = useRouter();

  const [side, setSide] = React.useState<TicketSide>('BUY');
  const [stakeText, setStakeText] = React.useState('10');
  const [multiplierText, setMultiplierText] = React.useState('1');
  const [stopLossText, setStopLossText] = React.useState('');
  const [takeProfitText, setTakeProfitText] = React.useState('');

  const [confirmSide, setConfirmSide] = React.useState<TicketSide | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState<string | null>(null);

  const stakeUsd = Number(stakeText);
  const multiplier = Number(multiplierText);
  const stopLoss = stopLossText.trim() === '' ? null : Number(stopLossText);
  const takeProfit = takeProfitText.trim() === '' ? null : Number(takeProfitText);

  const referencePrice = quote?.mid ?? null;
  const errors = validateTicket(
    { side, stakeUsd, multiplier, stopLoss, takeProfit },
    { referencePrice, availableUsd },
  );
  const valid = isTicketValid(errors);
  const notional = exposureNotional(stakeUsd, multiplier);

  const ready = symbol !== null && referencePrice !== null;

  /** BUY and SELL are the action buttons; each validates for its own side. */
  const choose = (next: TicketSide): void => {
    setSide(next);
    setError(null);
    const nextErrors = validateTicket(
      { side: next, stakeUsd, multiplier, stopLoss, takeProfit },
      { referencePrice, availableUsd },
    );
    if (isTicketValid(nextErrors)) setConfirmSide(next);
  };

  const submit = async (): Promise<void> => {
    if (!symbol || confirmSide === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        symbol,
        side: confirmSide,
        stakeUsd,
        multiplier,
      };
      if (stopLoss !== null) body.stopLoss = stopLoss;
      if (takeProfit !== null) body.takeProfit = takeProfit;

      const response = await apiFetch('/api/v1/positions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        setError(
          envelopeError(payload) ?? `The order was not placed (HTTP ${response.status}).`,
        );
        return;
      }

      const entry = openedEntryPrice(payload);
      setOpened(
        `Opened ${confirmSide} ${symbol}${entry === null ? '' : ` at ${priceFormatter.format(entry)}`}` +
          ` with a stake of ${`$${formatUsd(stakeUsd)}`}. That stake is the maximum loss on this position.`,
      );
      setConfirmSide(null);
      setStopLossText('');
      setTakeProfitText('');
      // The open book is server-rendered; re-render it so the new position is on it.
      router.refresh();
    } catch {
      setError('The order could not be submitted. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="p-5 pb-2">
        <CardTitle>Order ticket</CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Books an internal position at the market feed&apos;s price. Your stake is reserved from
          available cash and is the most this position can lose.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-5 pt-2">
        <div className="flex items-end justify-between gap-3 rounded-lg border border-line bg-base-900/50 px-3 py-2">
          <div className="flex flex-col">
            <span className="text-xs text-muted">Instrument</span>
            <span className="text-sm font-semibold text-base-100">{symbol ?? 'none selected'}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs text-muted">Bid / Ask</span>
            <span className="font-mono text-sm tabular-nums text-base-100">
              {typeof quote?.bid === 'number' && typeof quote?.ask === 'number' ? (
                <>
                  {priceFormatter.format(quote.bid)}
                  <span className="text-muted"> / </span>
                  {priceFormatter.format(quote.ask)}
                </>
              ) : (
                <span className="text-muted">no live quote</span>
              )}
            </span>
          </div>
        </div>

        {opened ? (
          <Alert variant="success">
            <AlertTitle>Position opened</AlertTitle>
            <AlertDescription>{opened}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="danger">
            <AlertTitle>The order was not placed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ticket-stake">Stake (USD)</Label>
            <Input
              id="ticket-stake"
              type="number"
              inputMode="decimal"
              min={TICKET_LIMITS.minStakeUsd}
              max={TICKET_LIMITS.maxStakeUsd}
              step="0.01"
              value={stakeText}
              onChange={(event) => setStakeText(event.target.value)}
            />
            {errors.stake ? (
              <span className="text-xs text-loss-400">{errors.stake}</span>
            ) : (
              <span className="text-xs text-muted">Maximum loss on this position.</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ticket-multiplier">Multiplier</Label>
            <Input
              id="ticket-multiplier"
              type="number"
              inputMode="numeric"
              min={1}
              max={TICKET_LIMITS.maxMultiplier}
              step="1"
              list="ticket-multiplier-options"
              value={multiplierText}
              onChange={(event) => setMultiplierText(event.target.value)}
            />
            <datalist id="ticket-multiplier-options">
              {MULTIPLIER_OPTIONS.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            {errors.multiplier ? (
              <span className="text-xs text-loss-400">{errors.multiplier}</span>
            ) : (
              <span className="text-xs text-muted">Scales exposure, not the money at risk.</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ticket-stop-loss">Stop loss (optional)</Label>
            <Input
              id="ticket-stop-loss"
              type="number"
              inputMode="decimal"
              step="0.00001"
              placeholder={side === 'BUY' ? 'below the price' : 'above the price'}
              value={stopLossText}
              onChange={(event) => setStopLossText(event.target.value)}
            />
            {errors.stopLoss ? (
              <span className="text-xs text-loss-400">{errors.stopLoss}</span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ticket-take-profit">Take profit (optional)</Label>
            <Input
              id="ticket-take-profit"
              type="number"
              inputMode="decimal"
              step="0.00001"
              placeholder={side === 'BUY' ? 'above the price' : 'below the price'}
              value={takeProfitText}
              onChange={(event) => setTakeProfitText(event.target.value)}
            />
            {errors.takeProfit ? (
              <span className="text-xs text-loss-400">{errors.takeProfit}</span>
            ) : null}
          </div>
        </div>

        <dl className="flex flex-col gap-1.5 rounded-lg border border-line bg-base-900/50 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Money at risk</dt>
            <dd className="font-mono tabular-nums text-base-100">
              {Number.isFinite(stakeUsd) && stakeUsd > 0 ? `$${formatUsd(stakeUsd)}` : '—'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Exposure (stake × multiplier)</dt>
            <dd className="font-mono tabular-nums text-base-100">
              {notional === null ? '—' : `$${formatUsd(notional)}`}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Available cash</dt>
            <dd className="font-mono tabular-nums text-base-100">
              {availableUsd === null ? 'not reported' : `$${formatUsd(availableUsd)}`}
            </dd>
          </div>
        </dl>

        <div className="grid grid-cols-2 gap-3">
          <Button
            type="button"
            variant="destructive"
            size="lg"
            disabled={!ready || submitting}
            onClick={() => choose('SELL')}
          >
            <ArrowDownRight aria-hidden />
            SELL
          </Button>
          <Button
            type="button"
            variant="success"
            size="lg"
            disabled={!ready || submitting}
            onClick={() => choose('BUY')}
          >
            <ArrowUpRight aria-hidden />
            BUY
          </Button>
        </div>
        {!ready ? (
          <p className="text-xs text-muted">
            {symbol === null
              ? 'Select an instrument to trade.'
              : 'Waiting for the first live quote on this instrument — the ticket prices nothing without one.'}
          </p>
        ) : null}
        {!valid && ready ? (
          <p className="text-xs text-muted">
            Fix the highlighted fields and press BUY or SELL again.
          </p>
        ) : null}
      </CardContent>

      <Dialog open={confirmSide !== null} onOpenChange={(next) => !next && setConfirmSide(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Confirm {confirmSide} {symbol}
            </DialogTitle>
            <DialogDescription>
              This books an internal position at the market feed&apos;s current price. It cannot be
              undone — a position is closed, never deleted.
            </DialogDescription>
          </DialogHeader>

          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Side</dt>
              <dd className="text-base-100">{confirmSide}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Stake (maximum loss)</dt>
              <dd className="font-mono tabular-nums text-base-100">${formatUsd(stakeUsd)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Exposure</dt>
              <dd className="font-mono tabular-nums text-base-100">
                {notional === null ? '—' : `$${formatUsd(notional)}`}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Stop loss</dt>
              <dd className="font-mono tabular-nums text-base-100">
                {stopLoss === null ? 'none' : priceFormatter.format(stopLoss)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Take profit</dt>
              <dd className="font-mono tabular-nums text-base-100">
                {takeProfit === null ? 'none' : priceFormatter.format(takeProfit)}
              </dd>
            </div>
          </dl>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmSide(null)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmSide === 'SELL' ? 'destructive' : 'success'}
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? 'Placing…' : `Confirm ${confirmSide} — $${formatUsd(stakeUsd)} at risk`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default OrderTicket;
