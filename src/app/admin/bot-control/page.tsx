import type { Metadata } from 'next';
import { Power } from 'lucide-react';

import { BotControlBar } from '@/components/admin/bot-control-bar';
import { BotRiskPanel } from '@/components/admin/bot-risk-panel';
import { SystemActivityFeed } from '@/components/admin/system-activity-feed';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { getAdminActivity, getBotControlView } from '@/server/modules/admin/admin.service';
import { requireStaffPage } from '../_lib/admin-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Bot control',
  description: 'Kill switch, platform risk limits and the live system activity feed.',
};

/**
 * Admin → Bot control (server component).
 *
 * Three jobs, in the order an operator needs them under pressure:
 *   1. stop everything (or release it) — the emergency stop;
 *   2. adjust the limits the bot enforces on the next order;
 *   3. watch what the platform is actually doing, live.
 *
 * Reachable by ADMIN and TRADING_MANAGER, but every mutating call is ADMIN-only
 * (re-checked against PostgreSQL, not the token). A manager therefore gets a
 * read-only view — the state, the reasons and the feed — rather than controls
 * that would fail on click.
 */
export default async function AdminBotControlPage() {
  const user = await requireStaffPage();
  const [view, activity] = await Promise.all([getBotControlView(), getAdminActivity(80)]);
  const isAdmin = user.role === 'ADMIN';
  const state = view.killSwitch;

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Back office"
        title="Bot control"
        description="Stop or resume trading, set the limits the engine enforces, and watch the platform's own activity stream."
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Bot control' }]}
      />

      {!isAdmin ? (
        <Alert variant="warn">
          <AlertTitle>Read-only for your role</AlertTitle>
          <AlertDescription>
            Only an ADMIN can change the kill switch or the risk limits. You are signed in as{' '}
            {user.role.replace(/_/g, ' ').toLowerCase()}, so this page shows the current state.
          </AlertDescription>
        </Alert>
      ) : null}

      {isAdmin ? (
        <>
          <BotControlBar initial={state} />
          <BotRiskPanel
            initial={state}
            instruments={view.symbols}
            instrumentsError={view.symbolsError}
          />
        </>
      ) : (
        <Card>
          <CardHeader className="p-5 pb-3">
            <CardTitle className="flex items-center gap-2">
              <Power aria-hidden className="size-4 text-brand-400" />
              Current state
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-5 pt-2 sm:grid-cols-2">
            <Detail
              label="Trading"
              value={state.enabled ? 'running' : `stopped${state.reason ? ` — ${state.reason}` : ''}`}
            />
            <Detail label="State read from" value={state.source} />
            <Detail label="Max stake per order" value={`${state.maxStakeUsd} USD`} />
            <Detail label="Daily loss limit" value={`${state.dailyLossLimitUsd} USD`} />
            <Detail label="Minimum payout" value={`${state.minPayoutPercentage}%`} />
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">Tradable symbols</span>
              {state.allowedSymbols.length === 0 ? (
                <Badge variant="outline">All symbols allowed</Badge>
              ) : (
                <span className="font-mono text-xs text-base-100">
                  {state.allowedSymbols.join(', ')}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <SystemActivityFeed initial={activity} />
    </Section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm text-base-100">{value}</span>
    </div>
  );
}
