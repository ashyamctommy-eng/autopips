import Link from 'next/link';

import { BotActivityFeed } from '@/components/dashboard/bot-activity-feed';
import { OpenPositions } from '@/components/dashboard/open-positions';
import { TradingPanel, type TradingPanelInvestment } from '@/components/dashboard/trading-panel';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { normaliseMarketSymbol } from '@/lib/contracts';
import {
  listActivity,
  listInvestments,
  listPositions,
  listTrades,
} from '@/server/modules/account/account.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listPublicSymbols } from '@/server/modules/market/public-market.service';

/**
 * Live trading (server component).
 *
 * Loads the account's positions and investments through the service layer, then
 * hands them to three client panels.
 *
 * The chart's instrument list starts with what this account has actually traded
 * and then continues with the broker's own instrument list. That second half is
 * why a brand-new account can see a chart at all: candles come from the PUBLIC
 * market feed, so an empty chart was never a data problem, only a missing
 * selection. The candles route still returns an empty series rather than a
 * synthetic one.
 */

export const dynamic = 'force-dynamic';

/** Window used to discover the instruments the account has traded. */
const INSTRUMENT_SAMPLE = 200;
/** Audit rows read as the feed's initial (stored) state. */
const ACTIVITY_TAKE = 50;

/**
 * Optional `?symbol=` deep link from the markets list. Read as untrusted input
 * and normalised before use: anything that is not a broker symbol is ignored,
 * so a made-up value never reaches the broker or the selector.
 */
interface TradingPageSearchParams {
  symbol?: string | string[];
}

export default async function DashboardTradingPage({
  searchParams,
}: {
  searchParams?: TradingPageSearchParams;
}) {
  const user = await requireSessionUser();

  const requestedSymbol = Array.isArray(searchParams?.symbol)
    ? searchParams?.symbol[0]
    : searchParams?.symbol;
  const initialSymbol = requestedSymbol ? normaliseMarketSymbol(requestedSymbol) : null;

  const [positions, investments, trades, activity] = await Promise.all([
    listPositions(user.id),
    listInvestments(user.id),
    listTrades(user.id, { take: INSTRUMENT_SAMPLE }),
    listActivity(user.id, ACTIVITY_TAKE),
  ]);

  // The broker's instrument list, read from its public feed. A failure here is
  // NOT fatal and never invented: the chart falls back to traded instruments.
  let availableInstruments: string[] = [];
  try {
    availableInstruments = (await listPublicSymbols())
      .map((instrument) => instrument.symbol)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn(
      `[dashboard/trading] instrument list unavailable: ${err instanceof Error ? err.message : err}`,
    );
  }

  const openPositions = positions.filter((position) => position.status === 'OPEN');

  const instrumentSet = new Set<string>();
  for (const position of positions) instrumentSet.add(position.instrument);
  for (const trade of trades.items) instrumentSet.add(trade.instrument);
  const instruments = Array.from(instrumentSet).sort((a, b) => a.localeCompare(b));

  const activeInvestment =
    investments.find((investment) => investment.status === 'ACTIVE') ??
    investments.find((investment) => investment.status === 'PAUSED') ??
    null;

  const panelInvestments: TradingPanelInvestment[] = investments.map((investment) => ({
    id: investment.id,
    planName: investment.planName,
    status: investment.status,
  }));

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Live trading"
        description="Market Feed candles, realtime position deltas and the strategy engine's own event stream — all read from verified market data."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Live trading' }]}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/dashboard/history">Trade history</Link>
          </Button>
        }
      />

      {activeInvestment === null ? (
        <div className="surface">
          <EmptyState
            title="No investment room to watch"
            description="Realtime candles and position deltas are scoped to an investment. Once capital is deployed into a plan, this screen subscribes to that room automatically."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard">Back to overview</Link>
              </Button>
            }
          />
        </div>
      ) : null}

      <TradingPanel
        investments={panelInvestments}
        instruments={instruments}
        availableInstruments={availableInstruments}
        investmentId={activeInvestment?.id ?? null}
        initialPositions={openPositions}
        initialSymbol={initialSymbol}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <OpenPositions
            investmentId={activeInvestment?.id ?? null}
            initialPositions={openPositions}
            emptyDescription="No position is open on this account right now. The strategy engine publishes a delta the moment one opens."
          />
        </div>
        <BotActivityFeed
          investmentId={activeInvestment?.id ?? null}
          initialEvents={activity}
        />
      </div>
    </Section>
  );
}
