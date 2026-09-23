/**
 * Fee engine: management fees, high-water-mark performance fees, and their
 * application to an investment.
 *
 * The two calculators are PURE (no I/O); `applyFees` is the only function here
 * that touches the database, and it never invents a trade row.
 *
 * MONEY: all arithmetic is Decimal (src/lib/money.ts), quantised to 2 dp.
 * Fees are clamped so they can never drive `Investment.currentValUsd` below zero.
 */

import { prisma } from '@/lib/prisma';
import { D, toPrismaDecimal, usd, type Numeric } from '@/lib/money';
import { redis, rkey } from '@/lib/redis';
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

// ------------------------------------------------------------------ application

/** Redis key holding the last fee-bearing equity for one investment (the HWM). */
function highWaterMarkKey(investmentId: string): string {
  return rkey('investment-hwm', investmentId);
}

/**
 * Reads the stored high-water mark.
 *
 * The Prisma model has no peak/HWM column, so the watermark lives in Redis
 * alongside the other runtime state (broker tokens, sync watermarks).
 * PRODUCTION: this belongs on `Investment` as `peakEquityUsd Decimal(18,2)` so the
 * watermark survives a Redis flush — `getStoredHighWaterMark` /
 * `setStoredHighWaterMark` are the only two functions that would change.
 */
export async function getStoredHighWaterMark(investmentId: string): Promise<number | null> {
  const stored = await redis.get(highWaterMarkKey(investmentId));
  if (!stored) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function setStoredHighWaterMark(investmentId: string, equity: number): Promise<void> {
  await redis.set(highWaterMarkKey(investmentId), String(equity));
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

/**
 * Applies management + performance fees to one investment.
 *
 * Writes only `Investment.feesDeducted` (incremented) and `currentValUsd`
 * (recomputed) inside a Prisma transaction — it deliberately records NO
 * `TradeRecord`: a fee is not a broker trade, and fabricating one would put an
 * unreal position in the client's trade history.
 *
 * SOLVENCY CLAMP: a fee can never push `currentValUsd` below zero. The chargeable
 * amount is capped at the investment's current value and the remainder is dropped
 * (reported as `clamped`), because billing a client into negative equity would be
 * a ledger error, not a receivable.
 */
export async function applyFees(input: ApplyFeesInput): Promise<ApplyFeesResult> {
  const investment = await prisma.investment.findUnique({ where: { id: input.investmentId } });
  if (!investment) throw new Error(`Investment ${input.investmentId} not found.`);

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

  const storedHwm = await getStoredHighWaterMark(input.investmentId);
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

  if (charged.greaterThan(0)) {
    await prisma.$transaction(async (tx) => {
      await tx.investment.update({
        where: { id: input.investmentId },
        data: {
          feesDeducted: toPrismaDecimal(feesAfter),
          currentValUsd: toPrismaDecimal(currentValAfter),
        },
      });
    });

    await recordAudit({
      action: AUDIT_FEE_APPLIED,
      userId: input.userId ?? investment.userId,
      ipAddress: input.ip ?? null,
      details: {
        investmentId: input.investmentId,
        managementFee: managementFee.toNumber(),
        performanceFee: performance.fee.toNumber(),
        charged: charged.toNumber(),
        clamped,
        requested: requested.toNumber(),
        highWaterMark: performance.highWaterMark.toNumber(),
        isNewHigh: performance.isNewHigh,
        feesDeductedAfter: feesAfter.toNumber(),
        currentValUsdAfter: currentValAfter.toNumber(),
      },
    });

    // The watermark only moves up, and only on a new high.
    if (performance.isNewHigh && currentValAfter.greaterThan(performance.highWaterMark)) {
      await setStoredHighWaterMark(input.investmentId, currentValAfter.toNumber());
    }
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
    performanceFee: performance.fee.toNumber(),
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
