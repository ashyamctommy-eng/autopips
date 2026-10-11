import Link from '@/lib/next/link';
import { LineChart } from 'lucide-react';

import { MarketsBoard } from '@/components/dashboard/markets-board';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { requireSessionUser } from '@/lib/services/session';
import { listMarketInstruments } from '@/lib/services/public-market.service';
import type { InstrumentInfo } from '@/types/broker.types';

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
    // The markets list is the broker catalogue PLUS the platform's own curated
    // instruments (oil, and any vendor-only symbol), so no tab is empty simply
    // because the broker does not list what the platform can quote.
    instruments = await listMarketInstruments();
  } catch (err) {
    feedAvailable = false;
    console.warn(
      `[dashboard/markets] public instrument feed unavailable: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  return (
    <Section width="wide" className="flex flex-col gap-4">
      {/*
       * NO HEADER BLOCK. The page opens directly on the quote board's search bar
       * and category tabs — a terminal shows the table, not a paragraph about the
       * table. The title survives as a screen-reader-only heading so the page is
       * not headless.
       */}
      <h1 className="sr-only">Markets</h1>

      {feedAvailable ? (
        <MarketsBoard instruments={instruments} />
      ) : (
        <div className="rounded-xl border border-line bg-base-850/60">
          <EmptyState
            icon={LineChart}
            title="Market data is unavailable"
            description="The Market Feed could not be reached, so there are no instruments and no prices to show. Nothing on this page is substituted with a stand-in figure — retry once the feed is reachable."
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
