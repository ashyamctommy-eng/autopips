/**
 * Fee engine: management fees, high-water-mark performance fees, and their
 * application to an investment.
 *
 * The two calculators are PURE (no I/O); `applyFees` is the only function here
 * that touches the database, and it never invents a trade row.
 *
 * MONEY: all arithmetic is Decimal (src/lib/money.ts), quantised to 2 dp.
 * Fees are clamped so they can never drive `Investment.currentValUsd` below zero.
 *
 * DURABILITY: the performance-fee high-water mark is `Investment.peakEquityUsd`.
 * Redis is a write-through cache only; a Redis flush can never lower the mark.
 *
 * ATOMICITY: `applyFees` is one transaction that locks the Investment row with
 * `SELECT ... FOR UPDATE` before it reads anything it is about to write.
 */

import { prisma } from '@/lib/prisma';
import { D, toPrismaDecimal, usd, type Numeric } from '@/lib/money';
import { redis, rkey } from '@/lib/redis';
import type { Prisma } from '@prisma/client';
import { recordAudit } from '../audit/audit.service';

/**
 * The audit table is append-only and its `action` column is a plain string, so a
 * fee entry gets its own clearly-named action instead of overloading an
 * investment-lifecycle constant (`INVESTMENT_CLOSED` would misstate the event).
 */
export const AUDIT_FEE_APPLIED = 'FEE_APPLIED';

/** Day-count basis for the pro-rata management fee. */
const DAYS_PER_YEAR = 365;

/**
 * A Prisma client, or the client handed to an interactive transaction callback.
 * The two expose the same model delegates, so every helper below takes one and
 * can run either stand-alone or inside the `applyFees` critical section.
 */
type InvestmentDb = Prisma.TransactionClient;

/**
 * Management fee, pro-rata for the elapsed period:
 *
 *   fee = capitalUsd × (annualPct / 100) × (daysElapsed / 365)
 *
 * Quantised to 2 dp (ROUND_HALF_UP, as brokers do). Zero elapsed days → zero fee
 * (a real zero, not a substituted value). Non-finite inputs → zero: a fee is a
 * debit, so "cannot evaluate" must never charge the client something invented.
 */
export function computeManagementFee(input: {
  capitalUsd: Numeric;
  annualPct: Numeric;
  daysElapsed: number;
}): ReturnType<typeof usd> {
  const capital = D(input.capitalUsd);
  const annual = D(input.annualPct);
  const days = D(input.daysElapsed);

  if (!capital.isFinite() || !annual.isFinite() || !days.isFinite()) return usd(0);
  if (capital.lessThanOrEqualTo(0) || annual.lessThanOrEqualTo(0) || days.lessThanOrEqualTo(0)) return usd(0);

  return usd(capital.times(annual.div(100)).times(days.div(DAYS_PER_YEAR)));
}

/** Result of the high-water-mark performance fee calculation. */
export interface PerformanceFeeResult {
  fee: ReturnType<typeof usd>;
  /** Equity level the fee was measured above (`max(startingCapital, peakEquity)`). */
  highWaterMark: ReturnType<typeof usd>;
  /** Profit above the previous high-water mark, before the fee. */
  profitAboveHwm: ReturnType<typeof usd>;
  /** True when there is no new high, i.e. nothing to charge. */
  isNewHigh: boolean;
}

/**
 * Performance fee with a HIGH-WATER MARK.
 *
 * The platform only ever charges performance on profit that takes the account to
 * a NEW all-time high — a client who loses money is not charged again on the way
 * back up to a level they had already paid for.
 *
 *   HWM      = max(startingCapital, peakEquity)     ← the previous high-water mark
 *   newHigh  = currentEquity > HWM
 *   fee      = newHigh ? (currentEquity − HWM) × performanceFeePct / 100 : 0
 *
 * `peakEquity` is the highest equity recorded at the previous fee event; a fresh
 * investment passes `peakEquity = startingCapital` and therefore pays only on
 * profit above its funded capital.
 *
 * Returns 0 whenever there is no new high, and always quantises to 2 dp.
 */
export function computePerformanceFee(input: {
  startingCapital: Numeric;
  peakEquity: Numeric;
  currentEquity: Numeric;
  performanceFeePct: Numeric;
}): PerformanceFeeResult {
  const starting = D(input.startingCapital);
  const peak = D(input.peakEquity);
  const current = D(input.currentEquity);
  const pct = D(input.performanceFeePct);

  if (!starting.isFinite() || !peak.isFinite() || !current.isFinite() || !pct.isFinite()) {
    return { fee: usd(0), highWaterMark: usd(0), profitAboveHwm: usd(0), isNewHigh: false };
  }

  const highWaterMark = usd(starting.greaterThan(peak) ? starting : peak);
  const profitAboveHwm = usd(current.minus(highWaterMark));

  if (profitAboveHwm.lessThanOrEqualTo(0) || pct.lessThanOrEqualTo(0)) {
    return { fee: usd(0), highWaterMark, profitAboveHwm: usd(0), isNewHigh: false };
  }

  return { fee: usd(profitAboveHwm.times(pct).div(100)), highWaterMark, profitAboveHwm, isNewHigh: true };
}

// ------------------------------------------------------- high-water-mark rules

/** Null unless the value is a real, finite number (a NaN column must not win). */
function finiteOrNull(value: Numeric | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = D(value);
  if (!parsed.isFinite()) return null;
  const number = parsed.toNumber();
  return Number.isFinite(number) ? number : null;
}

/**
 * PURE precedence rule for the stored high-water mark.
 *
 * `Investment.peakEquityUsd` is the AUTHORITY. Redis is a write-through cache
 * and is consulted only when the durable copy is absent — a row that predates
 * the column and still carries its watermark in Redis from the old design. That
 * legacy value is returned with `promote: true` so the caller writes it into the
 * column, after which a Redis flush cannot lose it.
 *
 * Consequences, both deliberate:
 *   * a cache MISS (flush/eviction) returns the durable value, never null;
 *   * a stale or lower cache entry can never override (or lower) the durable one.
 */
export function resolveStoredHighWaterMark(
  durable: Numeric | null | undefined,
  cached: Numeric | null | undefined,
): { value: number | null; promote: boolean } {
  const durableValue = finiteOrNull(durable);
  if (durableValue !== null) return { value: durableValue, promote: false };

  const cachedValue = finiteOrNull(cached);
  if (cachedValue !== null) return { value: cachedValue, promote: true };

  return { value: null, promote: false };
}

/**
 * PURE monotonicity rule: the high-water mark only ever RISES.
 *
 * A candidate at or below the stored mark leaves the stored mark untouched, so
 * no code path (a stale recompute, an out-of-order retry, a legacy cache entry)
 * can lower it. Quantised to 2 dp like every other money value.
 */
export function raiseHighWaterMark(
  existing: Numeric | null | undefined,
  candidate: Numeric,
): ReturnType<typeof usd> {
  const current = finiteOrNull(existing);
  const next = typeof candidate === 'number' ? candidate : D(candidate);
  const nextValue = finiteOrNull(next);

  if (nextValue === null) return current === null ? usd(0) : usd(current);
  if (current === null) return usd(nextValue);
  return nextValue > current ? usd(nextValue) : usd(current);
}

// ------------------------------------------------------------------ application

/** Redis key caching the durable high-water mark for one investment. */
function highWaterMarkKey(investmentId: string): string {
  return rkey('investment-hwm', investmentId);
}

/** Best-effort cache read. A Redis outage is "no cache", never "no watermark". */
async function readCachedHighWaterMark(investmentId: string): Promise<number | null> {
  try {
    const stored = await redis.get(highWaterMarkKey(investmentId));
    if (!stored) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the stored high-water mark.
 *
 * The DURABLE copy (`Investment.peakEquityUsd`) is the authority. Redis is a
 * cache: if the durable copy is missing (a row created before the column
 * existed) the cached value is used and immediately promoted into the column, so
 * a later cache flush cannot reset it and re-charge performance on profit the
 * client already paid for.
 */
export async function getStoredHighWaterMark(
  investmentId: string,
  db: InvestmentDb = prisma,
): Promise<number | null> {
  const row = await db.investment.findUnique({
    where: { id: investmentId },
    select: { peakEquityUsd: true },
  });
  const durable = row?.peakEquityUsd ?? null;

  const cached = await readCachedHighWaterMark(investmentId);
  const resolved = resolveStoredHighWaterMark(durable, cached);

  if (resolved.value !== null && resolved.promote) {
    await setStoredHighWaterMark(investmentId, resolved.value, db);
  }

  return resolved.value;
}

/**
 * Writes the stored high-water mark, monotonically.
 *
 * The DB write is a conditional `UPDATE ... WHERE peak IS NULL OR peak < value`,
 * so a lower candidate matches no row: the mark can only rise. The Redis entry
 * is then refreshed FROM the durable column (never the other way round), so the
 * cache can never be the source of a lower watermark.
 */
export async function setStoredHighWaterMark(
  investmentId: string,
  equity: Numeric,
  db: InvestmentDb = prisma,
): Promise<void> {
  const candidate = finiteOrNull(equity);
  if (candidate === null) return;

  await db.investment.updateMany({
    where: {
      id: investmentId,
      OR: [{ peakEquityUsd: null }, { peakEquityUsd: { lt: toPrismaDecimal(candidate) } }],
    },
    data: { peakEquityUsd: toPrismaDecimal(candidate) },
  });

  try {
    const row = await db.investment.findUnique({
      where: { id: investmentId },
      select: { peakEquityUsd: true },
    });
    const durable = row?.peakEquityUsd ?? null;
    if (durable !== null) {
      await redis.set(highWaterMarkKey(investmentId), durable.toString());
    }
  } catch {
    // Cache refresh is best-effort; the durable column is already written.
  }
}

export interface ApplyFeesInput {
  investmentId: string;
  /** Management fee terms. Omit to skip the management component. */
  management?: { annualPct: Numeric; daysElapsed: number };
  /** Performance fee terms (needs the stored HWM, or the funded capital). */
  performance?: { performanceFeePct: Numeric };
  /** Admin/user context for the audit row. */
  userId?: string | null;
  ip?: string | null;
  /**
   * The fee-period anchor to persist (`Investment.lastFeeAt`) when this call is
   * an accrual rather than an ad-hoc charge.
   *
   * It is written INSIDE the same transaction as the debit, so a charge and the
   * anchor that says "this period is billed" commit together. A caller that
   * advanced the anchor separately could crash in between and re-bill the whole
   * period on the next run.
   */
  markAccruedAt?: Date | null;
}

export interface ApplyFeesResult {
  investmentId: string;
  managementFee: number;
  performanceFee: number;
  /** Fee actually charged after the solvency clamp. */
  charged: number;
  /** True when the clamp reduced the fee (equity could not cover it). */
  clamped: boolean;
  feesDeductedBefore: number;
  feesDeductedAfter: number;
  currentValUsdBefore: number;
  currentValUsdAfter: number;
  highWaterMark: number;
  isNewHigh: boolean;
  auditAction: typeof AUDIT_FEE_APPLIED;
}

/** The transactional outcome, shaped before the post-commit audit call. */
interface ApplyFeesOutcome {
  investment: { id: string; userId: string };
  managementFee: ReturnType<typeof usd>;
  performanceFee: ReturnType<typeof usd>;
  performance: PerformanceFeeResult;
  requested: ReturnType<typeof usd>;
  charged: ReturnType<typeof usd>;
  clamped: boolean;
  feesBefore: ReturnType<typeof usd>;
  feesAfter: ReturnType<typeof usd>;
  currentValBefore: ReturnType<typeof usd>;
  currentValAfter: ReturnType<typeof usd>;
}

/**
 * Applies management + performance fees to one investment.
 *
 * ONE TRANSACTION, LOCK FIRST:
 *   1. `SELECT id FROM "Investment" WHERE id = $1 FOR UPDATE` — the platform's
 *      established serialisation pattern (payments.service.ts and
 *      account.service.ts lock the User row the same way). This is what makes
 *      the pass safe against another concurrent fee pass for the same
 *      investment: the read-compute-write cannot interleave.
 *   2. every figure (capital, P/L, feesDeducted, the stored high-water mark) is
 *      read INSIDE that lock, so nothing the computation sees can move before it
 *      is written back.
 *   3. `feesDeducted` is written as an ATOMIC SQL `increment` — never a
 *      read-then-overwrite — so a debit can never be lost.
 *   4. `currentValUsd` and `peakEquityUsd` are reconciled in the same critical
 *      section (see the ownership note below).
 *
 * OWNERSHIP OF `currentValUsd` (decided, not ambiguous):
 *   * `feesDeducted` is owned exclusively by this fee pass. It is monotonic and
 *     is the term the account-equity formula actually reads (Σ feesDeducted), so
 *     the money truth can never be lost to a concurrent writer.
 *   * `realizedPnL` / `unrealizedPnL` are owned exclusively by
 *     `recomputeInvestment` (broker-sourced).
 *   * `currentValUsd` is a DERIVED column. `recomputeInvestment` is its canonical
 *     rollup owner, but this fee pass also writes it, under the row lock, because
 *     an investment with no broker activity is never rolled up and would
 *     otherwise show a stale-high value forever. Both writers compute the same
 *     identity `capitalUsd + realizedPnL + unrealizedPnL − feesDeducted`, so they
 *     converge.
 *   * TRADE-OFF: `recomputeInvestment` reads without taking this lock (and this
 *     workstream does not own `broker.sync.ts`), so a rollup that read
 *     `feesDeducted` before this debit can, after our commit, rewrite
 *     `currentValUsd` from its pre-debit snapshot. That is a transient stale-high
 *     display value, not a lost fee: `feesDeducted` was incremented atomically
 *     and monotonically, the equity formula reads Σ feesDeducted, and the next
 *     rollup re-derives the exact identity. Making that race vanish entirely
 *     would require `recomputeInvestment` to take the same row lock.
 *
 * SOLVENCY CLAMP: a fee can never push `currentValUsd` below zero. The chargeable
 * amount is capped at the investment's current value and the remainder is
 * dropped (reported as `clamped`), because billing a client into negative equity
 * would be a ledger error, not a receivable.
 *
 * It deliberately records NO `TradeRecord`: a fee is not a broker trade, and
 * fabricating one would put an unreal position in the client's trade history.
 */
export async function applyFees(input: ApplyFeesInput): Promise<ApplyFeesResult> {
  const outcome = await prisma.$transaction(async (tx): Promise<ApplyFeesOutcome | null> => {
    // (a) Take the row lock before reading anything that will be written.
    await tx.$executeRaw`SELECT id FROM "Investment" WHERE id = ${input.investmentId} FOR UPDATE`;

    // (b) Read the figures inside the lock.
    const investment = await tx.investment.findUnique({ where: { id: input.investmentId } });
    if (!investment) return null;

    const capital = usd(investment.capitalUsd);
    const realized = usd(investment.realizedPnL);
    const unrealized = usd(investment.unrealizedPnL);
    const feesBefore = usd(investment.feesDeducted);
    // Equity backing this investment at this moment (same identity the sync uses).
    const currentValBefore = usd(capital.plus(realized).plus(unrealized).minus(feesBefore));

    const managementFee = input.management
      ? computeManagementFee({
          capitalUsd: capital,
          annualPct: input.management.annualPct,
          daysElapsed: input.management.daysElapsed,
        })
      : usd(0);

    const storedHwm = await getStoredHighWaterMark(input.investmentId, tx);
    const peakEquity = storedHwm === null ? capital : D(storedHwm);
    const performance = input.performance
      ? computePerformanceFee({
          startingCapital: capital,
          peakEquity,
          currentEquity: currentValBefore,
          performanceFeePct: input.performance.performanceFeePct,
        })
      : { fee: usd(0), highWaterMark: usd(capital), profitAboveHwm: usd(0), isNewHigh: false };

    const requested = usd(managementFee.plus(performance.fee));
    const chargeableFloor = currentValBefore.lessThan(0) ? usd(0) : currentValBefore;
    const charged = usd(DecimalMin(requested, chargeableFloor));
    const clamped = charged.lessThan(requested);

    const feesAfter = usd(feesBefore.plus(charged));
    const currentValAfter = usd(capital.plus(realized).plus(unrealized).minus(feesAfter));

    const markAt = input.markAccruedAt ?? null;

    if (charged.greaterThan(0)) {
      // (c) atomic increment + (d) same-lock reconciliation of the derived value.
      await tx.investment.update({
        where: { id: input.investmentId },
        data: {
          feesDeducted: { increment: toPrismaDecimal(charged) },
          currentValUsd: toPrismaDecimal(currentValAfter),
          ...(markAt ? { lastFeeAt: markAt } : {}),
        },
      });

      // The watermark update is inside the SAME critical section as the debit, so
      // the stored mark and the equity it is measured from cannot diverge. The
      // monotonic rule keeps the mark rising-only (a stale/lower candidate can
      // never replace it) and this is the only place it moves.
      if (performance.isNewHigh) {
        const nextMark = raiseHighWaterMark(performance.highWaterMark, currentValAfter);
        if (nextMark.greaterThan(performance.highWaterMark)) {
          await setStoredHighWaterMark(input.investmentId, nextMark, tx);
        }
      }
    } else if (markAt) {
      // Nothing chargeable this period (no new high, or no equity left to take).
      // Advance the anchor so the period is not re-billed on the next run — the
      // clamp already reported the dropped amount.
      await tx.investment.update({ where: { id: input.investmentId }, data: { lastFeeAt: markAt } });
    }

    return {
      investment: { id: investment.id, userId: investment.userId },
      managementFee,
      performanceFee: performance.fee,
      performance,
      requested,
      charged,
      clamped,
      feesBefore,
      feesAfter,
      currentValBefore,
      currentValAfter,
    };
  });

  if (!outcome) throw new Error(`Investment ${input.investmentId} not found.`);

  const {
    investment,
    managementFee,
    performanceFee,
    performance,
    requested,
    charged,
    clamped,
    feesBefore,
    feesAfter,
    currentValBefore,
    currentValAfter,
  } = outcome;

  if (charged.greaterThan(0)) {
    await recordAudit({
      action: AUDIT_FEE_APPLIED,
      userId: input.userId ?? investment.userId,
      ipAddress: input.ip ?? null,
      details: {
        investmentId: input.investmentId,
        managementFee: managementFee.toNumber(),
        performanceFee: performanceFee.toNumber(),
        charged: charged.toNumber(),
        clamped,
        requested: requested.toNumber(),
        highWaterMark: performance.highWaterMark.toNumber(),
        isNewHigh: performance.isNewHigh,
        feesDeductedAfter: feesAfter.toNumber(),
        currentValUsdAfter: currentValAfter.toNumber(),
      },
    });
  } else if (requested.greaterThan(0)) {
    // Nothing chargeable: record the refusal instead of silently dropping it.
    await recordAudit({
      action: AUDIT_FEE_APPLIED,
      userId: input.userId ?? investment.userId,
      ipAddress: input.ip ?? null,
      details: {
        investmentId: input.investmentId,
        requested: requested.toNumber(),
        charged: 0,
        clamped: true,
        reason: 'NO_CHARGEABLE_EQUITY',
        currentValUsd: currentValBefore.toNumber(),
      },
    });
  }

  return {
    investmentId: input.investmentId,
    managementFee: managementFee.toNumber(),
    performanceFee: performanceFee.toNumber(),
    charged: charged.toNumber(),
    clamped,
    feesDeductedBefore: feesBefore.toNumber(),
    feesDeductedAfter: feesAfter.toNumber(),
    currentValUsdBefore: currentValBefore.toNumber(),
    currentValUsdAfter: currentValAfter.toNumber(),
    highWaterMark: performance.highWaterMark.toNumber(),
    isNewHigh: performance.isNewHigh,
    auditAction: AUDIT_FEE_APPLIED,
  };
}

/** Local min helper (money.ts exports `clamp`, which needs a numeric range). */
function DecimalMin(a: ReturnType<typeof usd>, b: ReturnType<typeof usd>): ReturnType<typeof usd> {
  return a.lessThan(b) ? a : b;
}
