'use client';

import * as React from 'react';

import { ActivityFeed } from '@/components/shared/activity-feed';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import type { ActivityEventDTO } from '@/types/api';

/**
 * Bot activity feed (client component).
 *
 * Two real sources, merged and de-duplicated by event id:
 *  1. `initialEvents` — audit rows read by the server component for this
 *     account. The audit table is append-only, so every entry is something that
 *     actually happened; there is no synthetic "market" event anywhere.
 *  2. `bot:activity` over `useTradingSocket` — the live events the strategy
 *     engine, order manager and broker bridge publish into this investment's
 *     room (`trading:<investmentId>`).
 *
 * The stored list is account-wide (it includes sign-ins and settlements), so it
 * is narrowed to trading-runtime actions; the socket feed is already scoped to
 * the investment room. Nothing is generated, timed or replayed here.
 */

/** Actions the trading runtime publishes (audit names and bus names). */
const TRADING_ACTION_PREFIXES = [
  'BOT_',
  'RISK_',
  'SIGNAL_',
  'ORDER_',
  'POSITION_',
  'LOT_',
  'BROKER_',
  'FEE_',
] as const;

export function isTradingActivity(event: ActivityEventDTO): boolean {
  return TRADING_ACTION_PREFIXES.some((prefix) => event.action.startsWith(prefix));
}

/** Rows kept in the merged feed. */
const FEED_LIMIT = 60;

export interface BotActivityFeedProps {
  /** Investment room to mirror; null disables the live subscription. */
  investmentId: string | null;
  /** Server-read audit events for this account (any mix of actions). */
  initialEvents: ActivityEventDTO[];
}

export function BotActivityFeed({ investmentId, initialEvents }: BotActivityFeedProps) {
  const { activity, connected, status, serverError } = useTradingSocket({
    investmentId,
    enabled: Boolean(investmentId),
    activityLimit: 100,
  });

  const items = React.useMemo(() => {
    const byId = new Map<string, ActivityEventDTO>();
    // Live events first: for an id seen in both sources the socket copy wins.
    for (const event of [...activity, ...initialEvents.filter(isTradingActivity)]) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
    return Array.from(byId.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, FEED_LIMIT);
  }, [activity, initialEvents]);

  return (
    <div className="flex flex-col gap-3">
      {serverError ? (
        <Alert variant="warn">
          <AlertTitle>Realtime channel reported a problem</AlertTitle>
          <AlertDescription>{serverError.message}</AlertDescription>
        </Alert>
      ) : null}
      <ActivityFeed
        items={items}
        live={connected}
        title="Bot activity"
        description="Signal, risk, execution and closure events as they are published by the trading runtime."
        listClassName="max-h-[26rem]"
        emptyState={
          <EmptyState
            size="sm"
            title="No trading activity yet"
            description="Signals, risk decisions, broker executions and position closures stream in here the moment the engine publishes them."
            footer={
              investmentId
                ? status === 'connected'
                  ? undefined
                  : 'Realtime link is not connected — showing stored events only.'
                : 'This account has no investment room to subscribe to yet.'
            }
          />
        }
      />
    </div>
  );
}

export default BotActivityFeed;
