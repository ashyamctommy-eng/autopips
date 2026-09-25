import Link from 'next/link';
import { LineChart } from 'lucide-react';

import { MarketsBoard } from '@/components/dashboard/markets-board';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listPublicSymbols } from '@/server/modules/market/public-market.service';
import type { InstrumentInfo } from '@/server/modules/broker/broker.types';

/**
 * Markets (server component).
 *
 * Loads the broker's instrument list from the PUBLIC market feed — the feed is
 * unauthenticated by design, so no broker account is involved — and hands it to
 * one client board. `listPublicSymbols()` is uncached, so it is called once per
 * request, which is also why the page is explicitly dynamic.
 *
 * The feed failing is NOT a reason to draw something: the page then shows an
 * empty state naming the failure. No instrument and no price is ever generated
 * here. Realtime quotes are opened by the client board in a single socket, not
 * per row.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardMarketsPage() {
  await requireSessionUser();

  let instruments: InstrumentInfo[] = [];
  let feedAvailable = true;
  try {
    instruments = await listPublicSymbols();
  } catch (err) {
    feedAvailable = false;
    console.warn(
      `[dashboard/markets] public instrument feed unavailable: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Public market feed"
        title="Markets"
        description="The broker's own instrument list, with realtime quotes streamed over a single connection. A price is the broker's reported bid/ask shown at that instrument's precision — it is not converted to USD, and it is left blank rather than invented while the feed is quiet."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Markets' }]}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/dashboard/trading">Live trading</Link>
          </Button>
        }
      />

      {feedAvailable ? (
        <MarketsBoard instruments={instruments} />
      ) : (
        <div className="rounded-xl border border-line bg-base-850/60">
          <EmptyState
            icon={LineChart}
            title="Market data is unavailable"
            description="The broker's public feed could not be reached, so there are no instruments and no prices to show. Nothing on this page is substituted with a stand-in figure — retry once the feed is reachable."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/markets" prefetch={false}>
                  Retry
                </Link>
              </Button>
            }
          />
        </div>
      )}
    </Section>
  );
}
