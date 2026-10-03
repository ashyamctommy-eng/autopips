/**
 * Fee accrual pass.
 *
 * Runs on the bot cycle immediately after `runSyncCycle()` and charges the
 * management + high-water-mark performance fee for every ACTIVE/PAUSED
 * investment.
 *
 * WHY IT QUERIES ITS OWN SET OF INVESTMENTS
 *   The sync cycle only recomputes investments in its `touched` set — the ones
 *   with broker positions or deals this cycle. Hanging a fee pass off that set
 *   would silently skip exactly the investments that need charging: one that is
 *   funded and running but quiet (no open position, no new deal). This pass
 *   therefore issues its own `status IN ('ACTIVE','PAUSED')` query.
 *
 * HOW IT IS IDEMPOTENT (two independent guards)
 *   1. `claimOnce('fee:<investmentId>:<utc-day>')` — a Redis SET NX claim means
 *      at most one accrual per investment per UTC day, even when two runtime
 *      replicas race or a tick is retried. Redis down fails closed (no claim, no
 *      charge) and the period is recovered from `lastFeeAt` on a later run.
 *   2. `Investment.lastFeeAt` — the period ANCHOR. `daysElapsed` is always
 *      `now − (lastFeeAt ?? startDate)`, never `now − startDate`: a retry that
 *      reached `applyFees` advances the anchor atomically with the debit (see
 *      `ApplyFeesInput.markAccruedAt`), so the same days can never be billed
 *      twice. The anchor is also what makes a long outage catch up correctly
 *      (one charge covering the whole elapsed period, not one charge per day
 *      that was missed).
 *
 * A plan that charges nothing (managementFee = 0 AND performanceFee = 0) is a
 * pure no-op: no claim, no row write, no audit row. Otherwise the bot cycle
 * ticks every few seconds and the audit trail would fill with zero-value fees.
 *
 * FAILURE POLICY: one bad investment must not abort the pass (or the tick); it
 * is counted in the summary and audited as FEE_ACCRUAL_FAILED. The caller
 * (`bot.runtime.runCycle`) catches an escape from the pass itself.
 */

import { prisma } from '@/lib/prisma';
import { Decimal, D, type Numeric } from '@/lib/money';
import { claimOnce } from '@/lib/rate-limit';
import { recordAuditSafe } from '../audit/audit.service';
import { applyFees } from './fee.engine';

/** Its own audit action: "the accrual failed", distinct from "a fee was applied". */
export const AUDIT_FEE_ACCRUAL_FAILED = 'FEE_ACCRUAL_FAILED';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Claim TTL. The claim key contains the UTC day, so it only has to outlive that
 * day; two days covers a run at 23:59:59 and any same-day retry.
 */
const CLAIM_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * CRYSTALLISATION PERIOD: one charge per investment per UTC day.
 *
 * WHY DAILY, NOT PER TICK
 *   The bot ticks every few seconds. Charging on every tick would write a
 *   FEE_APPLIED audit row (and a `lastFeeAt` write) per investment per tick for a
 *   sub-cent fee — audit noise, not revenue. Daily crystallisation is also the
 *   standard managed-account convention for performance fees.
 *
 * KNOWN TRADE-OFF: because fees are quantised to cents, a management fee smaller
 * than half a cent per day (roughly `capital x annualPct < 1.83`) rounds to zero
 * every day and is not collected. The alternative — refusing to advance the
 * anchor until a cent accrues — re-bills the whole period on every run and is
 * precisely the retry hazard the anchor exists to prevent. If those small
 * accounts matter, lengthen the period (monthly crystallisation) rather than
 * making the anchor conditional.
 */

/** One investment's fee terms on its plan. */
export interface AccrualPlanTerms {
  managementFee: Numeric;
  performanceFee: Numeric;
}

/** The investment fields the pass needs (plus the joined plan). */
export interface AccrualInvestment {
  lastFeeAt: Date | null;
  startDate: Date | null;
}

export interface FeeAccrualSummary {
  /** ACTIVE/PAUSED investments examined. */
  scanned: number;
  /** Investments that were charged (> 0 USD). */
  charged: number;
  /** Total USD charged this pass, 2 dp. */
  feeTotal: number;
  /** Plans with no fees at all — skipped before any write or claim. */
  skippedZeroFee: number;
  /** ACTIVE rows with neither lastFeeAt nor startDate: no day-count possible. */
  skippedNoAnchor: number;
  /** Already claimed for this UTC day (another replica/tick won the race). */
  skippedClaimed: number;
  /** Investments whose fee pass threw; each one is audited. */
  errors: number;
}

/** PURE: does this plan charge anything at all? */
export function hasChargeableFees(plan: AccrualPlanTerms): boolean {
  const management = D(plan.managementFee);
  const performance = D(plan.performanceFee);
  const managementChargeable = management.isFinite() && management.greaterThan(0);
  const performanceChargeable = performance.isFinite() && performance.greaterThan(0);
  return managementChargeable || performanceChargeable;
}

/**
 * PURE: the instant the current fee period started.
 *
 * `lastFeeAt` (the previous accrual) wins; `startDate` seeds the FIRST period.
 * Deriving from `startDate` on every run would re-charge the whole life of the
 * investment on each tick — the defect this anchor exists to prevent.
 */
export function feeAccrualAnchor(investment: AccrualInvestment): Date | null {
  return investment.lastFeeAt ?? investment.startDate ?? null;
}

/**
 * PURE: fractional days from `anchor` to `now`, floored at zero.
 * A clock skew / retry that puts `now` before the anchor yields 0, not a
 * negative fee (a negative fee would be an invented credit).
 */
export function daysElapsedSince(anchor: Date, now: Date): number {
  const elapsedMs = now.getTime() - anchor.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return elapsedMs / MS_PER_DAY;
}

/** PURE: the UTC-day component of the idempotency claim key. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Charges one accrual period for every ACTIVE/PAUSED investment.
 *
 * `now` is injectable so the day-count and the claim key are deterministic in
 * tests; production always passes the default.
 */
export async function accrueFees(now: Date = new Date()): Promise<FeeAccrualSummary> {
  const investments = await prisma.investment.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] } },
    include: { plan: true },
  });

  const summary: FeeAccrualSummary = {
    scanned: 0,
    charged: 0,
    feeTotal: 0,
    skippedZeroFee: 0,
    skippedNoAnchor: 0,
    skippedClaimed: 0,
    errors: 0,
  };

  const periodKey = utcDayKey(now);
  let feeTotal = new Decimal(0);

  for (const investment of investments) {
    summary.scanned += 1;

    // Zero-fee plan: nothing to charge, so nothing to write, claim or audit.
    if (!hasChargeableFees(investment.plan)) {
      summary.skippedZeroFee += 1;
      continue;
    }

    const anchor = feeAccrualAnchor(investment);
    if (anchor === null) {
      // An ACTIVE investment with no startDate is a data defect, not a fee event.
      // Counted (and logged), deliberately NOT audited once per tick.
      summary.skippedNoAnchor += 1;
      console.warn(`[fee.accrual] investment ${investment.id} has no lastFeeAt/startDate; skipped.`);
      continue;
    }

    const claimed = await claimOnce(`fee:${investment.id}:${periodKey}`, CLAIM_TTL_SECONDS);
    if (!claimed) {
      summary.skippedClaimed += 1;
      continue;
    }

    try {
      const daysElapsed = daysElapsedSince(anchor, now);
      const result = await applyFees({
        investmentId: investment.id,
        management: { annualPct: investment.plan.managementFee, daysElapsed },
        performance: { performanceFeePct: investment.plan.performanceFee },
        userId: investment.userId,
        // Anchor and debit commit in the same transaction: a crash cannot leave a
        // charge recorded without the period it paid for, or the reverse.
        markAccruedAt: now,
      });

      if (result.charged > 0) {
        summary.charged += 1;
        feeTotal = feeTotal.plus(D(result.charged));
      }
    } catch (error) {
      summary.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fee.accrual] investment ${investment.id} failed:`, message);
      await recordAuditSafe({
        action: AUDIT_FEE_ACCRUAL_FAILED,
        userId: investment.userId,
        details: { investmentId: investment.id, periodKey, error: message },
      });
    }
  }

  summary.feeTotal = feeTotal.toNumber();
  return summary;
}
