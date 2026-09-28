'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Info,
  MessageSquare,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { cn, relativeTime } from '@/lib/utils';
import { formatUsd } from '@/lib/money';
import { isTradingActivity, mergeActivity } from '@/lib/activity';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { LiveDot } from '@/components/shared/live-dot';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import type { ActivityEventDTO } from '@/types/api';

/**
 * Messages — the account's trading log, live.
 *
 * This is the "Messages" surface rather than another activity list. Two real
 * sources, merged by id (see `mergeActivity`):
 *  1. `initialEvents` — audit rows the server read for this account. The audit
 *     table is append-only, so every row is something that actually happened.
 *  2. `bot:activity` over the socket. The server joins every authenticated
 *     socket to `user:<userId>`, so account-scoped events arrive without this
 *     page having to subscribe to anything; passing the active investment id
 *     additionally mirrors that investment's room.
 *
 * WHAT IS SHOWN ABOUT A TRADE
 *   `POSITION_OPENED` / `POSITION_CLOSED` audit rows carry the numbers the trade
 *   actually had — stake, entry price, realised P/L and the exit reason. They are
 *   read straight out of `details` and rendered; nothing is computed, and a field
 *   the row does not have simply produces no chip. A missing number is shown as
 *   missing, never as zero.
 */

const SEVERITY_META: Record<ActivityEventDTO['severity'], { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: 'text-brand-400' },
  success: { icon: CircleCheck, className: 'text-profit-400' },
  warning: { icon: TriangleAlert, className: 'text-warn-400' },
  error: { icon: CircleAlert, className: 'text-loss-400' },
};

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

/** How a closed position's `reason` is spelled for a person. */
const CLOSE_REASON_LABEL: Record<string, string> = {
  STOP_LOSS: 'Stop loss',
  TAKE_PROFIT: 'Take profit',
  MANUAL: 'Closed manually',
};

export interface MessagesFeedProps {
  /** Investment room to mirror in addition to the account room; null is fine. */
  investmentId: string | null;
  /** Server-read audit events for this account (any mix of actions). */
  initialEvents: ActivityEventDTO[];
}

function readNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readText(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** "+$12.34" / "-$5.00" — the sign is explicit, the magnitude is not re-derived. */
function signedUsd(value: number): string {
  return `${value < 0 ? '-' : '+'}$${formatUsd(Math.abs(value))}`;
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: 'profit' | 'loss' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] leading-tight',
        tone === 'profit'
          ? 'border-profit/30 bg-profit/10 text-profit-400'
          : tone === 'loss'
            ? 'border-loss/30 bg-loss/10 text-loss-400'
            : 'border-line bg-base-900/70 text-muted',
      )}
    >
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}

function SideChip({ side }: { side: string }) {
  const isBuy = side.toUpperCase() === 'BUY';
  const Icon = isBuy ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold leading-tight',
        isBuy ? 'border-profit/30 bg-profit/10 text-profit-400' : 'border-loss/30 bg-loss/10 text-loss-400',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {isBuy ? 'BUY' : 'SELL'}
    </span>
  );
}

/** The real numbers a trade message carries. No chip without a real value. */
function TradeDetails({ event }: { event: ActivityEventDTO }) {
  const chips: React.ReactNode[] = [];

  const side = readText(event.details, 'side');
  if (side) chips.push(<SideChip key="side" side={side} />);

  const stake = readNumber(event.details, 'stakeUsd');
  if (stake !== null) chips.push(<Chip key="stake" label="Stake" value={`$${formatUsd(stake)}`} />);

  if (event.action === 'POSITION_OPENED') {
    const entry = readNumber(event.details, 'entryPrice');
    if (entry !== null) {
      chips.push(<Chip key="entry" label="Entry" value={priceFormatter.format(entry)} />);
    }
  }

  if (event.action === 'POSITION_CLOSED') {
    const pnl = readNumber(event.details, 'realizedPnlUsd');
    if (pnl !== null) {
      chips.push(
        <Chip key="pnl" label="P/L" value={signedUsd(pnl)} tone={pnl < 0 ? 'loss' : 'profit'} />,
      );
    }
    const reason = readText(event.details, 'reason');
    if (reason) {
      chips.push(
        <Chip key="reason" label="Exit" value={CLOSE_REASON_LABEL[reason] ?? reason} />,
      );
    }
  }

  if (chips.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>;
}

export function MessagesFeed({ investmentId, initialEvents }: MessagesFeedProps) {
  const { activity, connected, serverError } = useTradingSocket({
    investmentId,
    enabled: true,
    activityLimit: 100,
  });

  const items = React.useMemo(
    () => mergeActivity(activity, initialEvents.filter(isTradingActivity)),
    [activity, initialEvents],
  );

  return (
    <div className="surface flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <LiveDot state={connected ? 'connected' : 'disconnected'} label={null} size="sm" />
            <h3 className="text-sm font-semibold text-base-100">Trade messages</h3>
          </div>
          <p className="text-xs text-muted">
            Trades, risk decisions and strategy status from the trading engine — stored history plus
            the live stream.
          </p>
        </div>
        <span className="shrink-0 text-[0.68rem] text-muted">
          {connected ? 'Live' : 'Stored only'}
        </span>
      </div>

      {serverError ? (
        <div className="px-4 pt-3">
          <Alert variant="warn">
            <AlertTitle>Realtime channel reported a problem</AlertTitle>
            <AlertDescription>{serverError.message}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={MessageSquare}
            title="No trade messages yet"
            description="The moment the engine opens or closes a position, or a strategy reports its state, the message lands here."
            footer={
              connected
                ? undefined
                : 'Realtime link is not connected — showing stored messages only.'
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            <AnimatePresence initial={false}>
              {items.map((event) => {
                const meta = SEVERITY_META[event.severity];
                const Icon = meta.icon;
                return (
                  <motion.li
                    key={event.id}
                    layout="position"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="flex items-start gap-3 px-4 py-3"
                  >
                    <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', meta.className)} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded border border-line bg-base-900/80 px-1.5 py-0.5 font-mono text-[0.68rem] leading-tight text-brand-300">
                          {event.action}
                        </code>
                        <time
                          dateTime={event.createdAt}
                          suppressHydrationWarning
                          className="ml-auto shrink-0 text-[0.68rem] tabular-nums text-muted"
                        >
                          {relativeTime(event.createdAt)}
                        </time>
                      </div>
                      <p className="break-words text-sm leading-relaxed text-base-100">
                        {event.message}
                      </p>
                      <TradeDetails event={event} />
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}

export default MessagesFeed;
