'use client';

import * as React from 'react';
import { Activity, Radio } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTradingSocket } from '@/hooks/use-trading-socket';
import { WS_EVENTS } from '@/lib/contracts';
import { isSystemStatus, type SystemStatusPayload } from '@/lib/socket-client';
import type { ActivityEventDTO } from '@/types/api';

/**
 * Live system activity feed (client component).
 *
 * Two streams, both from the admin room (an ADMIN socket auto-joins it; the
 * server refuses that room to anyone else):
 *
 *   • `bot:activity`        — the same append-only audit trail the platform
 *                             writes for every state change, streamed live;
 *   • `admin:system_status` — the kill-switch state, so the feed shows a halt at
 *                             the moment it happens rather than when someone
 *                             reloads the page.
 *
 * The feed is SEEDED with server-read rows and then prepended with live ones;
 * duplicates are dropped by id. Nothing here is synthesised: a quiet system
 * shows a quiet feed.
 */

export interface SystemActivityFeedProps {
  /** Recent audit rows, already read on the server. */
  initial: ActivityEventDTO[];
  /** Cap on rendered rows. */
  limit?: number;
}

type BadgeTone = 'success' | 'warn' | 'danger' | 'outline';

/** Audit severity → badge tone. An unknown severity is neutral, never alarming. */
function rowTone(severity: ActivityEventDTO['severity']): BadgeTone {
  switch (severity) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warn';
    case 'error':
      return 'danger';
    default:
      return 'outline';
  }
}

export function SystemActivityFeed({ initial, limit = 80 }: SystemActivityFeedProps) {
  const { activity, socket, status } = useTradingSocket({ enabled: true });
  const [systemStatus, setSystemStatus] = React.useState<SystemStatusPayload | null>(null);

  React.useEffect(() => {
    if (!socket) return;
    const handle = (payload: unknown) => {
      if (isSystemStatus(payload)) setSystemStatus(payload);
    };
    socket.on(WS_EVENTS.systemStatus, handle);
    return () => {
      socket.off(WS_EVENTS.systemStatus, handle);
    };
  }, [socket]);

  const rows = React.useMemo(() => {
    const seen = new Set<string>();
    const merged: ActivityEventDTO[] = [];
    for (const row of [...activity, ...initial]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
      if (merged.length >= limit) break;
    }
    return merged;
  }, [activity, initial, limit]);

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-3 p-5 pb-3">
        <CardTitle className="flex items-center gap-2">
          <Activity aria-hidden className="size-4 text-brand-400" />
          Live system activity
        </CardTitle>
        <span className="flex items-center gap-2 text-xs text-muted">
          <Radio aria-hidden className={status === 'connected' ? 'size-3 text-profit-400' : 'size-3'} />
          {status === 'connected' ? 'streaming' : status}
        </span>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-col gap-3 p-5 pt-2">
        {systemStatus ? (
          <div
            className={
              systemStatus.enabled
                ? 'rounded-lg border border-profit/30 bg-profit/[0.06] px-3 py-2 text-xs text-base-100'
                : 'rounded-lg border border-warn/40 bg-warn/[0.08] px-3 py-2 text-xs text-base-100'
            }
          >
            <span className="font-medium">
              {systemStatus.enabled ? 'Trading resumed' : 'Trading STOPPED'}
            </span>
            {systemStatus.reason ? <> — {systemStatus.reason}</> : null}
            <span className="ml-2 text-muted">
              {new Date(systemStatus.checkedAt).toLocaleTimeString('en-GB')}
            </span>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            No platform activity recorded yet. Audit rows appear here as the engine works.
          </p>
        ) : (
          <ul className="flex max-h-[28rem] flex-col divide-y divide-line overflow-y-auto">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={rowTone(row.severity)}>{row.action}</Badge>
                  <span className="text-xs text-muted">
                    {new Date(row.createdAt).toLocaleString('en-GB')}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-base-100">{row.message}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
