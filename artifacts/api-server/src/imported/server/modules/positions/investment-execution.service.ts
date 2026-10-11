/**
 * INTERNAL EXECUTION AGAINST CLIENT INVESTMENTS — option (b).
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * `EXECUTION_MODE=internal` used to book NOTHING: `order.manager.executeSignal`
 * refuses external orders in internal mode, and the bot runtime only iterated
 * `BrokerConnection` rows (of which there are none), so deployed client capital
 * sat inert and the client saw no P/L. This module closes that gap: it sizes and
 * opens `Position` rows ON THE PLATFORM'S OWN BOOK, linked to the `Investment`
 * whose deployed capital backs them.
 *
 * THE MONEY CONTRACT (do not break this — the ledger depends on it)
 * ─────────────────────────────────────────────────────────────────
 * An investment-linked position is a BREAKDOWN of the investment's deployed
 * capital, never a second pile:
 *
 *   Investment.capitalUsd        ← already counted as the client's deployed capital
 *   linked Position.stake        ← the SAME capital, sliced into trades
 *   linked Position.pnl          ← rolled up into the Investment's own
 *                                  realizedPnL / unrealizedPnL by
 *                                  `recomputeInvestmentFromPositions`
 *
 * So `accounting/ledger.ts` EXCLUDES linked positions (`investmentId: null`) from
 * its position aggregates. If it did not, every linked stake and every P/L mark
 * would be counted twice — the client's deployed capital would double and equity
 * would drift from the formula. The Investment columns are the single source of
 * money truth for a deployed strategy; the positions are the drill-down.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 *  * It never checks the withdrawable balance: the capital is ALREADY deployed
 *    (counted in `activeCapital`), so reserving it again would be double
 *    accounting. Only the total is clamped to the investment's capital.
 *  * It never throws out of a cycle. One bad symbol or one bad investment must
 *    not stop the engine; every failure is logged and the loop continues.
 */

import { prisma } from '@/lib/prisma';
import { D, toPrismaDecimal, usd, type Numeric } from '@/lib/money';
import { normaliseMarketSymbol } from '@/lib/contracts';
import { AUDIT, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { publishEquity } from '@/server/ws/event-bus';
import { curatedPlatformInstruments } from '@/server/modules/market/twelve-data.service';
import { getPublicCandles } from '@/server/modules/market/public-market.service';
import { getSetting, getSettingNumber } from '@/server/modules/settings/settings.service';
import { checkTradingAllowed } from '@/server/modules/bot/bot-control.service';
import { allocateStake } from '@/server/modules/bot/stake.allocator';
import { evaluateStrategy } from '@/server/modules/bot/strategy.engine';
import { isProtectivePairSane } from './position.math';
import { POSITION_MIN_STAKE_USD } from './position.service';

/* ────────────────────────────── small helpers ────────────────────────────── */

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Clamp a sized stake into the bounds an investment-linked position must obey:
 * `[POSITION_MIN_STAKE_USD, investment.capitalUsd]`. Returns null when the
 * investment cannot fund even the platform minimum.
 *
 * Rounding is DOWN to whole cents, never up: rounding a stake up would put more
 * at risk than the sizer (or the investment) authorised. The same doctrine as
 * `stake.allocator.ts`.
 */
export function clampStakeToInvestment(stakeUsd: number, capitalUsd: number): number | null {
  if (!Number.isFinite(stakeUsd) || !Number.isFinite(capitalUsd)) return null;
  if (capitalUsd < POSITION_MIN_STAKE_USD) return null;
  const clamped = Math.min(Math.max(stakeUsd, POSITION_MIN_STAKE_USD), capitalUsd);
  const cents = Math.floor(clamped * 100) / 100;
  return cents >= POSITION_MIN_STAKE_USD ? cents : null;
}

/* ────────────────────────────────── open ─────────────────────────────────── */

export interface OpenBotPositionInput {
  investmentId: string;
  userId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  stakeUsd: number;
  strategyId?: string | null;
}

export interface OpenBotPositionResult {
  opened: boolean;
  positionId: string | null;
  reason: string | null;
  stakeUsd: number | null;
}

function refuse(reason: string): OpenBotPositionResult {
  return { opened: false, positionId: null, reason, stakeUsd: null };
}

/**
 * Open ONE internally-executed position against an investment's deployed capital.
 *
 * Differences from `position.service.openPosition` are deliberate:
 *   * NO withdrawable-balance check — this capital is already deployed, and the
 *     ledger already counts it in `activeCapital`. Reserving it again would be
 *     counting the same money twice.
 *   * The stake is CLAMPED to the investment's `capitalUsd`, so a single trade
 *     can never exceed the client's committed capital.
 *   * `investmentId` is set, which is what makes the ledger exclude the row from
 *     the standalone position aggregates and roll it into the Investment instead.
 *
 * Returns a result object (never throws for a business refusal) so the cycle can
 * record and continue.
 */
export async function openBotPosition(input: OpenBotPositionInput): Promise<OpenBotPositionResult> {
  const symbol = normaliseMarketSymbol(input.symbol);
  if (!symbol) return refuse('INVALID_SYMBOL');

  const side = input.side === 'BUY' || input.side === 'SELL' ? input.side : null;
  if (!side) return refuse('INVALID_SIDE');

  const entryPrice = positiveFinite(input.entryPrice);
  if (entryPrice === null) return refuse('INVALID_ENTRY_PRICE');

  let stopLoss: number | null = null;
  if (input.stopLoss !== null && input.stopLoss !== undefined) {
    stopLoss = positiveFinite(input.stopLoss);
    if (stopLoss === null) return refuse('INVALID_STOP_LOSS');
  }
  let takeProfit: number | null = null;
  if (input.takeProfit !== null && input.takeProfit !== undefined) {
    takeProfit = positiveFinite(input.takeProfit);
    if (takeProfit === null) return refuse('INVALID_TAKE_PROFIT');
  }

  // Fail-closed protective-pair sanity: a BUY must stop BELOW and target ABOVE
  // its entry (mirror for a SELL). A crossed pair would fire immediately at a
  // loss the client never intended.
  if (!isProtectivePairSane({ side, entryPrice, stopLoss, takeProfit })) {
    return refuse('UNSANE_PROTECTIVE_PAIR');
  }

  const investment = await prisma.investment.findUnique({
    where: { id: input.investmentId },
    select: { userId: true, capitalUsd: true, status: true },
  });
  if (!investment || investment.userId !== input.userId) return refuse('INVESTMENT_NOT_FOUND');
  // Only a deployed investment may carry bot positions. A PAUSED/MATURED/CLOSED
  // row must not get new trades (the cycle only selects ACTIVE, but this is the
  // authoritative check).
  if (investment.status !== 'ACTIVE') return refuse('INVESTMENT_NOT_ACTIVE');

  const stake = clampStakeToInvestment(input.stakeUsd, D(investment.capitalUsd).toNumber());
  if (stake === null) return refuse('BELOW_MINIMUM_STAKE');

  const created = await prisma.position.create({
    data: {
      userId: input.userId,
      investmentId: input.investmentId,
      strategyId: input.strategyId ?? null,
      symbol,
      side,
      stake: toPrismaDecimal(stake),
      // Spot-like exposure: the stake IS the notional. The bot's internal book
      // does not apply a multiplier.
      multiplier: toPrismaDecimal(1),
      entryPrice: toPrismaDecimal(entryPrice, 5),
      // The mark starts at the entry price; the tick engine moves it.
      currentPrice: toPrismaDecimal(entryPrice, 5),
      stopLoss: stopLoss === null ? null : toPrismaDecimal(stopLoss, 5),
      takeProfit: takeProfit === null ? null : toPrismaDecimal(takeProfit, 5),
      pnl: toPrismaDecimal(0),
      status: 'OPEN',
      executionMode: 'INTERNAL',
    },
  });

  // Audit failure must not undo a booked position, so the safe writer is used.
  await recordAuditSafe({
    action: AUDIT.POSITION_OPENED,
    userId: input.userId,
    details: {
      positionId: created.id,
      investmentId: input.investmentId,
      strategyId: input.strategyId ?? null,
      symbol,
      side,
      stakeUsd: stake,
      entryPrice,
      stopLoss,
      takeProfit,
      executionMode: 'INTERNAL',
      source: 'BOT_INTERNAL',
      // The ledger treats this stake as part of the investment's deployed
      // capital, NOT as a second deployed-capital term (see the file header).
      ledger: 'PART_OF_INVESTMENT_DEPLOYED_CAPITAL',
    },
  });

  return { opened: true, positionId: created.id, reason: null, stakeUsd: stake };
}

/* ───────────────────────────────── idempotency ───────────────────────────── */

/**
 * True when this investment already has an OPEN position for the same
 * (symbol, strategyId). Used to make the cycle idempotent: a re-run or a second
 * replica must not re-open the same setup for the same client.
 */
export async function hasOpenLinkedPosition(
  investmentId: string,
  symbol: string,
  strategyId: string | null,
): Promise<boolean> {
  const row = await prisma.position.findFirst({
    where: { investmentId, symbol, strategyId, status: 'OPEN' },
    select: { id: true },
  });
  return row !== null;
}

/* ─────────────────────────────── roll-up ─────────────────────────────────── */

export interface InvestmentPositionRollup {
  investmentId: string;
  userId: string;
  capitalUsd: number;
  realizedPnL: number;
  unrealizedPnL: number;
  feesDeducted: number;
  currentValUsd: number;
}

/**
 * Rewrite one investment's P/L columns from its OWN linked positions.
 *
 *   realizedPnL   = Σ(pnl of CLOSED linked positions)
 *   unrealizedPnL = Σ(pnl of OPEN   linked positions)
 *   currentValUsd = capitalUsd + realizedPnL + unrealizedPnL − feesDeducted
 *
 * Runs in a Prisma transaction and then publishes the resulting equity snapshot
 * to the owner (and the admin room). Returns null when the investment is gone.
 */
export async function recomputeInvestmentFromPositions(
  investmentId: string,
): Promise<InvestmentPositionRollup | null> {
  const rollup = await prisma.$transaction(async (tx) => {
    const investment = await tx.investment.findUnique({
      where: { id: investmentId },
      select: { id: true, userId: true, capitalUsd: true, feesDeducted: true },
    });
    if (!investment) return null;

    const [closed, open, closedTrades] = await Promise.all([
      tx.position.aggregate({
        where: { investmentId, status: 'CLOSED' },
        _sum: { pnl: true },
      }),
      tx.position.aggregate({
        where: { investmentId, status: 'OPEN' },
        _sum: { pnl: true },
      }),
      // Broker-path realised P/L lives on TradeRecord (broker.sync writes the same
      // `realizedPnL` column from it). Without this term the roll-up would CLOBBER
      // it the moment a linked position was marked.
      tx.tradeRecord.aggregate({
        where: { investmentId, status: 'CLOSED' },
        _sum: { netPnL: true },
      }),
    ]);

    const capital = usd(investment.capitalUsd);
    const realized = usd(closedTrades._sum.netPnL ?? 0).plus(usd(closed._sum.pnl ?? 0));
    const unrealized = usd(open._sum.pnl ?? 0);
    const fees = usd(investment.feesDeducted);
    const currentVal = usd(capital.plus(realized).plus(unrealized).minus(fees));

    await tx.investment.update({
      where: { id: investmentId },
      data: {
        realizedPnL: toPrismaDecimal(realized),
        unrealizedPnL: toPrismaDecimal(unrealized),
        currentValUsd: toPrismaDecimal(currentVal),
      },
    });

    return {
      investmentId,
      userId: investment.userId,
      capitalUsd: capital.toNumber(),
      realizedPnL: realized.toNumber(),
      unrealizedPnL: unrealized.toNumber(),
      feesDeducted: fees.toNumber(),
      currentValUsd: currentVal.toNumber(),
    } satisfies InvestmentPositionRollup;
  });

  if (!rollup) return null;

  await publishEquity(
    rollup.userId,
    {
      scope: 'investment',
      investmentId: rollup.investmentId,
      capitalUsd: rollup.capitalUsd,
      realizedPnL: rollup.realizedPnL,
      unrealizedPnL: rollup.unrealizedPnL,
      feesDeducted: rollup.feesDeducted,
      currentValUsd: rollup.currentValUsd,
      at: new Date().toISOString(),
    },
    true,
  );

  return rollup;
}

/* ─────────────────────────── strategy cycle ──────────────────────────────── */

/**
 * The subset of a runtime strategy config this cycle needs. Structurally
 * satisfied by `StrategyRuntimeConfig` in `bot.runtime.ts` (which is why this
 * type lives here rather than importing the runtime back into the service — that
 * would be a cycle).
 */
export interface InternalStrategyConfig {
  /** Entry rule: `ema-rsi` (default) or `rsi-reversion`. */
  rule?: 'ema-rsi' | 'rsi-reversion';
  timeframe: string;
  masterVolume: number;
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  candleCount: number;
  stopLookback?: number;
  rewardRisk?: number;
}

export interface InternalStrategyCycleEntry {
  symbol: string;
  investmentId?: string;
  outcome: 'OPENED' | 'SKIPPED' | 'GATED' | 'ERROR';
  reason?: string;
}

export interface InternalStrategyCycleResult {
  strategyId: string;
  symbolsEvaluated: number;
  signals: number;
  opened: number;
  skipped: number;
  errors: number;
  entries: InternalStrategyCycleEntry[];
}

/**
 * One strategy cycle on the platform's OWN book.
 *
 *   * Symbol universe = the operator-curated platform instruments
 *     (`market.instruments`), intersected with `risk.allowed_symbols` when that
 *     setting is non-empty.
 *   * Candles come from `getPublicCandles` (no broker connection required).
 *   * Every active investment is sized independently with `allocateStake`, and a
 *     signal opens AT MOST ONE position per (investment, symbol, strategy):
 *     an investment that already holds an OPEN linked position for the setup is
 *     skipped, so a re-run or a second replica cannot double-open.
 *   * `checkTradingAllowed` (kill switch, allow-list, daily loss limit) gates
 *     every symbol before any position is opened.
 *
 * NEVER THROWS. Any per-symbol or per-investment failure is logged, counted in
 * `errors`, and the loop continues — one bad instrument must not stop the engine
 * for every client.
 */
export async function runInternalStrategyCycle(
  strategyId: string,
  config: InternalStrategyConfig,
): Promise<InternalStrategyCycleResult> {
  const result: InternalStrategyCycleResult = {
    strategyId,
    symbolsEvaluated: 0,
    signals: 0,
    opened: 0,
    skipped: 0,
    errors: 0,
    entries: [],
  };

  let investments: Array<{
    id: string;
    userId: string;
    capitalUsd: Numeric;
    currentValUsd: Numeric;
    plan: { maxDrawdown: Numeric };
  }>;
  try {
    investments = await prisma.investment.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        userId: true,
        capitalUsd: true,
        currentValUsd: true,
        plan: { select: { maxDrawdown: true } },
      },
    });
  } catch (err) {
    console.error(
      '[investment-execution] could not load active investments:',
      err instanceof Error ? err.message : err,
    );
    result.errors += 1;
    return result;
  }
  // No deployed capital → nothing to trade. An empty universe is a valid state,
  // not an error.
  if (investments.length === 0) return result;

  // Symbol universe: the curated platform list, narrowed by the risk allow-list
  // ONLY when the operator has set one (an empty list means "no restriction").
  const curated = curatedPlatformInstruments();
  const allowed = getSetting('risk.allowed_symbols')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const symbols = allowed.length > 0 ? curated.filter((symbol) => allowed.includes(symbol)) : curated;

  const riskPerTradePct = getSettingNumber('risk.risk_per_trade_pct');
  const platformCapUsd = getSettingNumber('risk.max_stake_usd');

  // Minimal adapter shim: the strategy engine only needs candle history.
  const adapter = {
    getHistoricalCandles: (symbol: string, timeframe: string, count: number) =>
      getPublicCandles(symbol, timeframe, count),
  };

  for (const symbol of symbols) {
    try {
      result.symbolsEvaluated += 1;

      // Fetch the bar series ourselves so the ENTRY PRICE is the signal bar's
      // close — deterministic and exactly what the strategy derived its stop and
      // target from. (The shim below refetches through the engine's own path; the
      // market client caches candles for the bar interval, so this is cheap.)
      const candles = await getPublicCandles(symbol, config.timeframe, Math.trunc(config.candleCount));
      if (candles.length === 0) continue;
      const last = candles[candles.length - 1]!;
      const entryPrice = positiveFinite(Number(last.close));
      if (entryPrice === null) continue;

      const signal = await evaluateStrategy({
        adapter,
        symbol,
        timeframe: config.timeframe,
        config: {
          strategy: strategyId,
          rule: config.rule,
          fastPeriod: config.fastPeriod,
          slowPeriod: config.slowPeriod,
          rsiPeriod: config.rsiPeriod,
          rsiOverbought: config.rsiOverbought,
          rsiOversold: config.rsiOversold,
          candleCount: config.candleCount,
          masterVolume: config.masterVolume,
          stopLookback: config.stopLookback,
          rewardRisk: config.rewardRisk,
        },
      });
      if (!signal) continue;
      result.signals += 1;

      // Platform gate: kill switch, symbol allow-list, daily loss limit. Checked
      // BEFORE any position is opened.
      const gate = await checkTradingAllowed(symbol);
      if (!gate.allowed) {
        result.skipped += 1;
        result.entries.push({ symbol, outcome: 'GATED', reason: gate.code });
        await recordAuditSafe({
          action: AUDIT.RISK_KILL_SWITCH,
          details: {
            phase: 'internal_strategy_cycle',
            strategyId,
            symbol,
            code: gate.code,
            reason: gate.reason,
          },
        });
        continue;
      }

      for (const investment of investments) {
        try {
          // Idempotency: at most ONE OPEN position per
          // (investment, symbol, strategy).
          if (await hasOpenLinkedPosition(investment.id, symbol, strategyId)) {
            result.skipped += 1;
            result.entries.push({
              symbol,
              investmentId: investment.id,
              outcome: 'SKIPPED',
              reason: 'ALREADY_OPEN',
            });
            continue;
          }

          const allocation = allocateStake({
            capitalUsd: D(investment.capitalUsd).toNumber(),
            currentValUsd: D(investment.currentValUsd).toNumber(),
            maxDrawdownPct: D(investment.plan.maxDrawdown).toNumber(),
            riskPerTradePct,
            platformCapUsd,
            multiplier: 1,
          });

          if (allocation.skipped || allocation.stake === null) {
            result.skipped += 1;
            result.entries.push({
              symbol,
              investmentId: investment.id,
              outcome: 'SKIPPED',
              reason: allocation.skipReason ?? 'NOT_SIZED',
            });
            await recordAuditSafe({
              action: AUDIT.STAKE_ALLOCATED,
              userId: investment.userId,
              details: {
                investmentId: investment.id,
                strategyId,
                symbol,
                skipped: true,
                skipReason: allocation.skipReason ?? null,
                bounds: allocation.bounds,
                source: 'BOT_INTERNAL',
              },
            });
            continue;
          }

          const opened = await openBotPosition({
            investmentId: investment.id,
            userId: investment.userId,
            symbol,
            side: signal.direction,
            entryPrice,
            stopLoss: signal.stopLoss ?? null,
            takeProfit: signal.takeProfit ?? null,
            stakeUsd: allocation.stake,
            strategyId,
          });

          if (opened.opened) {
            result.opened += 1;
            result.entries.push({ symbol, investmentId: investment.id, outcome: 'OPENED' });
          } else {
            result.skipped += 1;
            result.entries.push({
              symbol,
              investmentId: investment.id,
              outcome: 'SKIPPED',
              reason: opened.reason ?? 'REFUSED',
            });
          }
        } catch (err) {
          result.errors += 1;
          result.entries.push({ symbol, investmentId: investment.id, outcome: 'ERROR' });
          console.error(
            `[investment-execution] could not open ${symbol} for investment ${investment.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      result.errors += 1;
      result.entries.push({ symbol, outcome: 'ERROR' });
      console.error(
        `[investment-execution] symbol ${symbol} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}
