import type { ActivityEventDTO } from '@/types/api';

/**
 * Trading activity — shared by the trading screen's feed and the Messages tab.
 *
 * It lives here rather than inside a component because it is not presentation:
 * the same rule (which audit actions are *trading* activity) decides both what
 * the trading screen shows and what the Messages tab shows, and a second copy of
 * that list would drift the moment a new action is added.
 *
 * The list is prefixes, not exact actions, on purpose: a new `POSITION_*` action
 * is trading activity by definition, and requiring this file to be edited on
 * every addition would guarantee it eventually is not.
 */

/** Actions the trading runtime publishes (audit names and bus names). */
export const TRADING_ACTION_PREFIXES = [
  'BOT_',
  'RISK_',
  'SIGNAL_',
  'ORDER_',
  'POSITION_',
  'LOT_',
  'BROKER_',
  'FEE_',
] as const;

/** True when the event belongs to the trading runtime rather than the account. */
export function isTradingActivity(event: Pick<ActivityEventDTO, 'action'>): boolean {
  return TRADING_ACTION_PREFIXES.some((prefix) => event.action.startsWith(prefix));
}

/** Rows kept in a merged feed. */
export const ACTIVITY_FEED_LIMIT = 60;

/**
 * Merge the live socket stream over the stored audit rows.
 *
 * Two real sources, de-duplicated by event id:
 *  - `live` — `bot:activity` events received over the socket, newest first;
 *  - `stored` — audit rows read by the server for this account.
 *
 * An event seen in both resolves to the socket copy: it is the same event, and
 * the live payload is the one the client already applied. Ordering is by
 * `createdAt` descending and the result is capped, so the caller can render
 * `items[0]` as the newest entry.
 */
export function mergeActivity(
  live: readonly ActivityEventDTO[],
  stored: readonly ActivityEventDTO[],
  limit: number = ACTIVITY_FEED_LIMIT,
): ActivityEventDTO[] {
  const byId = new Map<string, ActivityEventDTO>();
  for (const event of live) if (!byId.has(event.id)) byId.set(event.id, event);
  for (const event of stored) if (!byId.has(event.id)) byId.set(event.id, event);

  return Array.from(byId.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, Math.max(0, limit));
}
