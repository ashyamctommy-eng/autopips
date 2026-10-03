import { History as HistoryIcon } from 'lucide-react';

import { PlBar, type PlBarDatum } from '@/components/charts/pl-bar';
import { TradeHistory } from '@/components/dashboard/trade-history';
import { MetricTile } from '@/components/shared/metric-tile';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SignedUsd } from '@/components/shared/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { D, sum } from '@/lib/money';
import { listTrades, type TradeDTO } from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';

/**
 * Trade history (server component).
 *
 * Cursor pagination is owned by `listTrades`: the first page is read here and
 * handed to the client table, which asks the API for subsequent pages with the
 * cursor it was given. The per-instrument P/L bar is built from a bounded sample
 * of the account's most recent trades, and the caption says exactly how many
 * trades it covers — an aggregate is never presented as if it were the whole
 * book.
 */

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
/** Sample window for the instrument summary and the filter options. */
const SAMPLE_SIZE = 200;
const STATUS_FILTERS = ['OPEN', 'CLOSED', 'CANCELLED'] as const;

interface HistorySearchParams {
  status?: string;
  instrument?: string;
  cursor?: string;
}

function normalizeStatus(value: string | undefined): string | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return (STATUS_FILTERS as readonly string[]).includes(upper) ? upper : null;
}

/** Realised P/L per instrument, summed exactly in Decimal then degraded once. */
function plByInstrument(trades: TradeDTO[]): PlBarDatum[] {
  const groups = new Map<string, TradeDTO[]>();
  for (const trade of trades) {
    if (trade.status !== 'CLOSED') continue;
    const bucket = groups.get(trade.instrument);
    if (bucket) bucket.push(trade);
    else groups.set(trade.instrument, [trade]);
  }

  return Array.from(groups.entries())
    .map(([label, rows]) => ({ label, value: sum(rows.map((row) => D(row.netPnL))).toNumber() }))
    .sort((a, b) => b.value - a.value);
}

export default async function DashboardHistoryPage({
  searchParams,
}: {
  searchParams: HistorySearchParams;
}) {
  const user = await requireSessionUser();

  const status = normalizeStatus(searchParams.status);
  const instrument = searchParams.instrument?.trim() ? searchParams.instrument.trim() : null;
  const cursor = instrument ? undefined : searchParams.cursor?.trim() || undefined;

  const [page, sample] = await Promise.all([
    listTrades(user.id, {
      status: status ?? undefined,
      take: instrument ? SAMPLE_SIZE : PAGE_SIZE,
      cursor,
    }),
    listTrades(user.id, { take: SAMPLE_SIZE }),
  ]);

  const instruments = Array.from(new Set(sample.items.map((trade) => trade.instrument))).sort(
    (a, b) => a.localeCompare(b),
  );

  const filtered = instrument
    ? page.items.filter((trade) => trade.instrument === instrument).slice(0, PAGE_SIZE)
    : page.items;
  const nextCursor = instrument ? null : page.nextCursor;

  const sampleIsTruncated = sample.nextCursor !== null;
  const closedInSample = sample.items.filter((trade) => trade.status === 'CLOSED');
  const realisedInSample = sum(closedInSample.map((trade) => D(trade.netPnL))).toNumber();
  const plData = plByInstrument(sample.items);
  const windowLabel = `the most recent ${SAMPLE_SIZE} trades`;

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Trade history"
        description="Closed trades with the broker's own gross P/L, commission and swap. Rows are written from broker-confirmed fills only."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'History' }]}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Trades in window"
          value={sample.items.length}
          sub={sampleIsTruncated ? windowLabel : 'all recorded trades'}
          icon={HistoryIcon}
        />
        <MetricTile
          label="Realized P/L"
          value={<SignedUsd value={realisedInSample} />}
          sub={`${closedInSample.length} closed trade${closedInSample.length === 1 ? '' : 's'} in ${
            sampleIsTruncated ? `the last ${SAMPLE_SIZE}` : 'the whole book'
          }`}
        />
        <MetricTile
          label="Instruments traded"
          value={instruments.length}
          sub={sampleIsTruncated ? `seen in ${windowLabel}` : 'seen in every trade'}
        />
      </div>

      <Card>
        <CardHeader className="p-5 pb-2">
          <CardTitle>Realized P/L by instrument</CardTitle>
          <p className="text-xs leading-relaxed text-muted">
            Sum of the broker&apos;s net P/L per instrument
            {sampleIsTruncated ? ` across ${windowLabel}` : ' across every closed trade'}.
          </p>
        </CardHeader>
        <CardContent className="p-5 pt-2">
          {plData.length === 0 ? (
            <EmptyState
              size="sm"
              title="No realized P/L yet"
              description="Once the broker reports a closing deal, its net result is attributed to the instrument here."
            />
          ) : (
            <PlBar data={plData} valueLabel="Net P/L" height={240} />
          )}
        </CardContent>
      </Card>

      <TradeHistory
        initialItems={filtered}
        initialNextCursor={nextCursor}
        status={status}
        instrument={instrument}
        instruments={instruments}
        instrumentWindow={Boolean(instrument)}
      />
    </Section>
  );
}
