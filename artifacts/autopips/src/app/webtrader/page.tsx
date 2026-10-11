import type { Metadata } from '@/lib/next/types';

import { TradingPanel, type TradingPanelInvestment } from '@/components/dashboard/trading-panel';
import { normaliseMarketSymbol } from '@/lib/contracts';
import { listInvestments, listPositions, listTrades } from '@/lib/services/account.service';
import { requireSessionUser } from '@/lib/services/session';
import { listPublicSymbols } from '@/lib/services/public-market.service';
import { getWallet } from '@/lib/services/position.service';

/**
 * Standalone WebTrader (server component).
 *
 * Hydrates the full-screen terminal with the same verified data as the dashboard
 * trading panel — the account's investments, its traded instruments and the
 * public feed's instrument list — then hands it to `TradingPanel` in
 * `fullscreen` mode.
 *
 * The dashboard version of this screen also mounts positions tables and an
 * activity feed. Those are dashboard furniture; a terminal that fills the
 * viewport has no room for them, so they are simply not rendered here rather
 * than being hidden with CSS.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'WebTrader',
  description: 'Full-screen trading terminal.',
  robots: { index: false, follow: false },
};

/** Window used to discover the instruments this account has traded. */
const INSTRUMENT_SAMPLE = 200;

/**
 * `?symbol=` deep link (e.g. from a Markets row). Read as untrusted input and
 * normalised before use, so a made-up value never reaches the feed or selector.
 */
interface WebTraderSearchParams {
  symbol?: string | string[];
}

export default async function WebTraderPage({
  searchParams,
}: {
  searchParams?: WebTraderSearchParams;
}) {
  const user = await requireSessionUser();

  const requestedSymbol = Array.isArray(searchParams?.symbol)
    ? searchParams?.symbol[0]
    : searchParams?.symbol;
  const initialSymbol = requestedSymbol ? normaliseMarketSymbol(requestedSymbol) : null;

  const [positions, investments, trades, wallet] = await Promise.all([
    listPositions(user.id),
    listInvestments(user.id),
    listTrades(user.id, { take: INSTRUMENT_SAMPLE }),
    getWallet(user.id),
  ]);

  // The feed's instrument list. A failure here is NOT fatal and never invented:
  // the selector falls back to the instruments this account has actually traded.
  let availableInstruments: string[] = [];
  let closedSymbols: string[] = [];
  try {
    const feedInstruments = await listPublicSymbols();
    availableInstruments = feedInstruments
      .map((instrument) => instrument.symbol)
      .sort((a, b) => a.localeCompare(b));
    closedSymbols = feedInstruments
      .filter((instrument) => instrument.exchangeIsOpen === false)
      .map((instrument) => instrument.symbol);
  } catch (err) {
    console.warn(
      `[webtrader] instrument list unavailable: ${err instanceof Error ? err.message : err}`,
    );
  }

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
    <TradingPanel
      fullscreen
      investments={panelInvestments}
      instruments={instruments}
      availableInstruments={availableInstruments}
      closedSymbols={closedSymbols}
      investmentId={activeInvestment?.id ?? null}
      initialPositions={positions.filter((position) => position.status === 'OPEN')}
      initialSymbol={initialSymbol}
      availableUsd={wallet.availableUsd}
    />
  );
}
