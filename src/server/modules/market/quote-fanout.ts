import { publishTick } from '@/server/ws/event-bus';
import { markPositionPrice } from '@/server/modules/positions/position.service';
import type { Quote } from '@/server/modules/broker/broker.types';

/**
 * ONE fan-out point for a market quote.
 *
 * WHY THIS EXISTS
 *   A tick has two consumers now, not one:
 *     1. the socket feed (charts and the markets list), and
 *     2. the INTERNAL POSITION ENGINE, which marks open positions to market.
 *
 *   Those used to be separate concerns, and the tick path called `publishTick`
 *   only — so an internal position's `pnl` would never move with the market no
 *   matter how many ticks arrived. Routing every tick through here means any
 *   price source (the broker adapter today, a Twelve Data stream next) drives
 *   P&L automatically, instead of each source having to remember to.
 */

/**
 * The single price a quote contributes to mark-to-market, or null.
 *
 * A synthetic quotes one number; a forex/CFD quotes a bid and an ask, and the
 * MID is the honest mark for a position (using the bid would mark every long
 * down by half the spread on entry).
 */
export function markPriceFromQuote(
  quote: Pick<Quote, 'bid' | 'ask' | 'quote'>,
): number | null {
  const single = quote.quote;
  if (typeof single === 'number' && Number.isFinite(single) && single > 0) return single;

  const bid = typeof quote.bid === 'number' && Number.isFinite(quote.bid) && quote.bid > 0 ? quote.bid : null;
  const ask = typeof quote.ask === 'number' && Number.isFinite(quote.ask) && quote.ask > 0 ? quote.ask : null;

  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask;
}

/**
 * Fan a quote out to the socket feed and to the position engine.
 *
 * Marking a position is best-effort: a database blip while marking must never
 * stop prices reaching every other watching client, so its failure is logged and
 * swallowed. The tick itself is published first for the same reason.
 */
export async function publishMarketQuote(quote: Quote): Promise<void> {
  await publishTick({ ...quote });

  const price = markPriceFromQuote(quote);
  if (price === null) return;

  try {
    await markPositionPrice(quote.symbol, price);
  } catch (err) {
    console.error(
      `[positions] could not mark ${quote.symbol} at ${price}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
