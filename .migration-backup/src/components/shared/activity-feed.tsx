'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { cn, relativeTime } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { LiveDot } from '@/components/shared/live-dot';
import type { ActivityEventDTO } from '@/types/api';
import type { ActivitySeverity, BotActivity } from '@/server/modules/bot/bot.types';

/**
 * Both payload shapes are accepted:
 *  - `ActivityEventDTO` — what the REST API and the socket bus emit to clients.
 *  - `BotActivity` — what the bot runtime publishes on the wire (adds `rooms`).
 * Detection is by the presence of the `rooms` field.
 */
export type ActivityFeedItem = ActivityEventDTO | BotActivity;

export function isBotActivity(item: ActivityFeedItem): item is BotActivity {
  return Array.isArray((item as Partial<BotActivity>).rooms);
}

interface FeedEntry {
  id: string;
  action: string;
  message: string;
  severity: ActivitySeverity;
  createdAt: string;
  details: Record<string, unknown>;
  rooms: string[] | null;
}

const SEVERITY_META: Record<ActivitySeverity, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: 'text-brand-400' },
  success: { icon: CircleCheck, className: 'text-profit-400' },
  warning: { icon: TriangleAlert, className: 'text-warn-400' },
  error: { icon: CircleAlert, className: 'text-loss-400' },
};

export interface ActivityFeedProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  items: ActivityFeedItem[];
  /** Keep only the newest N events (the caller still owns the source list). */
  max?: number;
  /** Render the pulsing live indicator in the header. */
  live?: boolean;
  /** Header label. Defaults to "Activity". */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Rendered in place of the list when `items` is empty. */
  emptyState?: React.ReactNode;
  isLoading?: boolean;
  /** Scroll the list back to the newest entry when one arrives. Default true. */
  autoScroll?: boolean;
  /** Max height of the scrolling region, e.g. `max-h-96`. */
  listClassName?: string;
  headerActions?: React.ReactNode;
}

function toEntry(item: ActivityFeedItem): FeedEntry {
  const severity: ActivitySeverity =
    item.severity === 'info' ||
    item.severity === 'success' ||
    item.severity === 'warning' ||
    item.severity === 'error'
      ? item.severity
      : 'info';
  return {
    id: item.id,
    action: item.action,
    message: item.message,
    severity,
    createdAt: item.createdAt,
    details: item.details ?? {},
    rooms: isBotActivity(item) ? item.rooms : null,
  };
}

/**
 * Live bot/trading activity stream.
 *
 * Newest-first: the newest event is item 0, and the scroll region is pinned to
 * the top whenever the head changes. It renders exactly the events it is given
 * — an empty array yields an empty state, never a sample row.
 */
export function ActivityFeed({
  items,
  max,
  live = false,
  title = 'Activity',
  description,
  emptyState,
  isLoading = false,
  autoScroll = true,
  listClassName,
  headerActions,
  className,
  ...props
}: ActivityFeedProps) {
  const entries = React.useMemo(() => items.map(toEntry), [items]);
  const visible = React.useMemo(
    () => (typeof max === 'number' ? entries.slice(0, Math.max(0, max)) : entries),
    [entries, max],
  );
  const newestId = visible[0]?.id ?? null;

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const lastSeenHead = React.useRef<string | null>(newestId);

  React.useEffect(() => {
    if (!autoScroll) return;
    if (lastSeenHead.current === newestId) return;
    lastSeenHead.current = newestId;
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: 0, behavior: 'smooth' });
  }, [newestId, autoScroll]);

  return (
    <div
      className={cn('surface flex flex-col overflow-hidden', className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {live ? <LiveDot state="connected" label={null} size="sm" /> : null}
            <h3 className="text-sm font-semibold text-base-100">{title}</h3>
          </div>
          {description ? <p className="text-xs text-muted">{description}</p> : null}
        </div>
        {headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
      </div>

      <div ref={scrollRef} className={cn('flex-1 overflow-y-auto', listClassName)}>
        {isLoading ? (
          <ul className="flex flex-col divide-y divide-line/60">
            {Array.from({ length: 4 }, (_, index) => (
              <li key={`activity-skeleton-${index}`} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-full max-w-xs" />
                </div>
              </li>
            ))}
          </ul>
        ) : visible.length === 0 ? (
          emptyState ?? (
            <EmptyState
              size="sm"
              icon={Info}
              title="No activity yet"
              description="Trade, risk and settlement events stream in here as soon as the engine publishes them."
            />
          )
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            <AnimatePresence initial={false}>
              {visible.map((entry) => {
                const meta = SEVERITY_META[entry.severity];
                const Icon = meta.icon;
                return (
                  <motion.li
                    key={entry.id}
                    layout="position"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="flex items-start gap-3 px-4 py-3"
                  >
                    <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', meta.className)} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded border border-line bg-base-900/80 px-1.5 py-0.5 font-mono text-[0.68rem] leading-tight text-brand-300">
                          {entry.action}
                        </code>
                        {entry.rooms && entry.rooms.length > 0 ? (
                          <span className="font-mono text-[0.65rem] text-muted">
                            {entry.rooms.join(' · ')}
                          </span>
                        ) : null}
                        <time
                          dateTime={entry.createdAt}
                          suppressHydrationWarning
                          className="ml-auto shrink-0 text-[0.68rem] tabular-nums text-muted"
                        >
                          {relativeTime(entry.createdAt)}
                        </time>
                      </div>
                      <p className="break-words text-sm leading-relaxed text-base-100">
                        {entry.message}
                      </p>
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
