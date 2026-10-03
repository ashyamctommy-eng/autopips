import { prisma } from '@/lib/prisma';
import { D, usd, type Decimal } from '@/lib/money';
import type { StrategyStats } from '@/types/api';

/**
 * LIVE strategy metrics.
 *
 * Business directive #1 (Zero Simulation): the public site advertises strategy
 * performance. Every number on those cards is derived here from real
 * TradeRecord rows written from MetaApi broker deals. When there is no closed
 * trade history, the stats object is null and the UI must say "no verified
 * track record yet" rather than showing a flattering placeholder.
 *
 * Directive #2 (No Guaranteed Returns): `indicativeOnly` is hard-coded true so
 * the type itself forces the UI to render the non-guarantee caveat.
 */

interface CachedStats {
  stats: StrategyStats | null;
  computedAt: number;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, CachedStats>();

/**
 * Verified aggregate performance for one plan.
 *
 * Returns `null` when the plan has no closed trades — a plan with zero history
 * has no win rate, and reporting 0% or 100% would both be fabrications.
 */
export async function getStrategyStats(
  planId: string,
  opts: { fresh?: boolean } = {},
): Promise<StrategyStats | null> {
  const cached = cache.get(planId);
  if (!opts.fresh && cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.stats;
  }

  const trades = await prisma.tradeRecord.findMany({
    where: { investment: { planId }, status: 'CLOSED' },
    select: {
      netPnL: true,
      grossPnL: true,
      closedAt: true,
      investmentId: true,
    },
    orderBy: { closedAt: 'asc' },
  });

  // Capital that actually produced these trades, so "observed return" and the
  // drawdown are measured against what was genuinely at risk.
  //
  // Scoping to investments that have at least one CLOSED trade matters: using
  // every investment on the plan (including ones that never traded, or were
  // closed long ago) inflates the denominator and silently UNDERSTATES the
  // observed return — a verified 3.75% reported where the real figure was
  // 15.00%. Understating is the "safe" direction to be wrong in, but a wrong
  // number is still a wrong number.
  const investments = await prisma.investment.findMany({
    where: { planId, trades: { some: { status: 'CLOSED' } } },
    select: { id: true, capitalUsd: true },
  });

  const stats = buildStats(planId, trades, investments);
  cache.set(planId, { stats, computedAt: Date.now() });
  return stats;
}

function buildStats(
  planId: string,
  trades: { netPnL: Decimal; grossPnL: Decimal; closedAt: Date | null; investmentId: string }[],
  investments: { id: string; capitalUsd: Decimal }[],
): StrategyStats | null {
  if (trades.length === 0) return null;

  let wins = 0;
  let losses = 0;
  let grossProfit = D(0);
  let grossLoss = D(0);
  let net = D(0);
  let running = D(0);
  let peak = D(0);
  let maxDrawdownPct = D(0);

  for (const t of trades) {
    const pnl = D(t.netPnL);
    net = net.plus(pnl);
    running = running.plus(pnl);

    if (pnl.greaterThan(0)) {
      wins += 1;
      grossProfit = grossProfit.plus(pnl);
    } else if (pnl.lessThan(0)) {
      losses += 1;
      grossLoss = grossLoss.plus(pnl.abs());
    }

    // Equity-curve drawdown on realised P/L, expressed against deployed capital.
    if (running.greaterThan(peak)) peak = running;
    const dd = peak.minus(running);
    if (dd.greaterThan(0)) {
      const totalCapital = investments.reduce<Decimal>((acc, i) => acc.plus(D(i.capitalUsd)), D(0));
      if (totalCapital.greaterThan(0)) {
        const ddPct = dd.div(totalCapital).times(100);
        if (ddPct.greaterThan(maxDrawdownPct)) maxDrawdownPct = ddPct;
      }
    }
  }

  const totalCapital = investments.reduce<Decimal>((acc, i) => acc.plus(D(i.capitalUsd)), D(0));
  const decisive = wins + losses;

  return {
    planId,
    closedTrades: trades.length,
    winningTrades: wins,
    losingTrades: losses,
    // Win rate over decisive outcomes only; break-even trades are excluded
    // rather than counted as wins.
    winRatePct: decisive === 0 ? null : usd(D(wins).div(decisive).times(100)).toNumber(),
    grossProfit: usd(grossProfit).toNumber(),
    grossLoss: usd(grossLoss).toNumber(),
    netPnL: usd(net).toNumber(),
    observedReturnPct: totalCapital.greaterThan(0)
      ? net.div(totalCapital).times(100).toDecimalPlaces(4).toNumber()
      : null,
    maxObservedDrawdownPct: totalCapital.greaterThan(0)
      ? maxDrawdownPct.toDecimalPlaces(4).toNumber()
      : null,
    firstTradeAt: trades[0]?.closedAt?.toISOString() ?? null,
    lastTradeAt: trades[trades.length - 1]?.closedAt?.toISOString() ?? null,
    indicativeOnly: true,
  };
}

/** Invalidate one plan's cache (called when trades close). */
export function invalidateStrategyStats(planId?: string): void {
  if (planId) cache.delete(planId);
  else cache.clear();
}

/**
 * Wins/losses across every plan, for the public headline metrics band.
 * Returns null when the platform has no closed trades at all.
 */
export async function getPlatformTradingStats(): Promise<{
  closedTrades: number;
  winRatePct: number | null;
  netPnL: number;
  instruments: string[];
  activeStrategies: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
} | null> {
  const [closed, open, plans] = await Promise.all([
    prisma.tradeRecord.findMany({
      where: { status: 'CLOSED' },
      select: { netPnL: true, instrument: true, closedAt: true },
    }),
    prisma.tradeRecord.findMany({
      where: { status: 'OPEN' },
      select: { instrument: true },
    }),
    prisma.tradingPlan.count({ where: { isActive: true } }),
  ]);

  if (closed.length === 0) return null;

  let wins = 0;
  let losses = 0;
  let net = D(0);
  let first: Date | null = null;
  let last: Date | null = null;

  for (const t of closed) {
    const pnl = D(t.netPnL);
    net = net.plus(pnl);
    if (pnl.greaterThan(0)) wins += 1;
    else if (pnl.lessThan(0)) losses += 1;
    if (t.closedAt) {
      if (!first || t.closedAt < first) first = t.closedAt;
      if (!last || t.closedAt > last) last = t.closedAt;
    }
  }

  const decisive = wins + losses;
  const instruments = Array.from(
    new Set([...closed.map((t) => t.instrument), ...open.map((t) => t.instrument)]),
  ).sort();

  return {
    closedTrades: closed.length,
    winRatePct: decisive === 0 ? null : usd(D(wins).div(decisive).times(100)).toNumber(),
    netPnL: usd(net).toNumber(),
    instruments,
    activeStrategies: plans,
    firstTradeAt: first?.toISOString() ?? null,
    lastTradeAt: last?.toISOString() ?? null,
  };
}
