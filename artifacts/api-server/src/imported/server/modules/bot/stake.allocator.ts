/**
 * Stake sizing for stake-denominated brokers (Deriv multipliers).
 *
 * PURE: no I/O, no Prisma, no clock, no randomness — the same discipline as
 * `lot.allocator.ts`, and for the same reason: this decides how much client
 * money is put at risk, so it must be reproducible and testable in isolation.
 *
 * THE EXPOSURE MODEL (settled 2026-09-25 — see HANDOVER.md §Exposure model)
 * -----------------------------------------------------------------------
 * A Deriv multiplier contract is bought with a STAKE, and the stake IS the
 * maximum loss: Deriv cannot take more than it, a stop-loss can only reduce it,
 * and a take-profit realises the gain. The notional the position is exposed to
 * is `stake × multiplier`.
 *
 * So risk is sized in the unit that actually bounds the loss — dollars at risk —
 * and the notional is DERIVED from it and reported, never used to size the
 * trade. Doing it the other way round (targetting a notional) makes the money at
 * risk a function of the multiplier, which is a configuration value that changes
 * independently of the client's capital.
 *
 *   stake = min( capital × riskPerTradePct
 *              , capital × maxDrawdownPct − lossAlreadyTaken   ← the plan's stop
 *              , platformMaxStake )                            ← the console's cap
 *   notional = stake × multiplier
 *
 * Every bound is a HARD floor on the result: the allocation is rounded DOWN to
 * cents and skipped entirely when it falls below MIN_STAKE_USD. Rounding up, or
 * trading a nominal size to "make the trade happen", would quietly exceed the
 * very limit that produced the number.
 */

/** Deriv's own minimum stake is below a cent; this is the PLATFORM's floor. */
export const MIN_STAKE_USD = 1;

/** Proposed default for `risk.risk_per_trade_pct`; the console owns the value. */
export const DEFAULT_RISK_PER_TRADE_PCT = 1;

export interface StakeAllocationInput {
  /** Funded capital for this investment, USD. Null when the ledger has none. */
  capitalUsd: number | null;
  /** Current value of the investment, USD. Used to measure the drawdown taken. */
  currentValUsd: number | null;
  /** The plan's drawdown stop, percent of capital (read from the plan). */
  maxDrawdownPct: number;
  /** `risk.risk_per_trade_pct` — percent of capital risked per trade. */
  riskPerTradePct: number;
  /** `risk.max_stake_usd` — the operator's per-order ceiling. 0 = no ceiling. */
  platformCapUsd: number;
  /** Contract multiplier (Deriv multipliers, e.g. 100). */
  multiplier: number;
}

export interface StakeAllocation {
  /** Money to put at risk, rounded DOWN to cents. Null when skipped. */
  stake: number | null;
  /** Derived exposure (stake × multiplier). Null when skipped. */
  notional: number | null;
  skipped: boolean;
  /** Machine-readable reason, recorded in the audit row. */
  skipReason?: StakeSkipReason;
  /** The bounds the decision was made against, for the audit trail. */
  bounds: {
    riskBudgetUsd: number | null;
    drawdownBudgetUsd: number | null;
    platformCapUsd: number | null;
  };
}

export type StakeSkipReason =
  | 'NO_CAPITAL'
  | 'RISK_PER_TRADE_UNSET'
  | 'MULTIPLIER_UNSET'
  | 'DRAWDOWN_BUDGET_EXHAUSTED'
  | 'BELOW_MINIMUM_STAKE';

/** Down to whole cents, never up. */
function toCents(value: number): number {
  return Math.floor(value * 100) / 100;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Size one order.
 *
 * A skip is a first-class outcome, not an error: every reason below means "this
 * order cannot be sized inside the limits the platform was given", and the
 * caller records it and moves on. Refusing is the correct behaviour — the
 * alternative is a number nobody authorised.
 */
export function allocateStake(input: StakeAllocationInput): StakeAllocation {
  const capital = finite(input.capitalUsd);
  const currentValue = finite(input.currentValUsd) ?? capital;
  const multiplier = finite(input.multiplier);
  const cap = finite(input.platformCapUsd);

  const empty = (skipReason: StakeSkipReason, bounds: StakeAllocation['bounds']): StakeAllocation => ({
    stake: null,
    notional: null,
    skipped: true,
    skipReason,
    bounds,
  });

  const bounds = {
    riskBudgetUsd: null as number | null,
    drawdownBudgetUsd: null as number | null,
    platformCapUsd: cap !== null && cap > 0 ? cap : null,
  };

  if (capital === null || capital <= 0) return empty('NO_CAPITAL', bounds);

  // A risk percentage of 0 means "put nothing at risk" — a deliberate operator
  // setting, not a missing value, so it is refused rather than defaulted.
  if (!Number.isFinite(input.riskPerTradePct) || input.riskPerTradePct <= 0) {
    return empty('RISK_PER_TRADE_UNSET', bounds);
  }

  // Without a multiplier there is no notional, and a position whose exposure
  // cannot be stated is one the risk system cannot reason about.
  if (multiplier === null || multiplier <= 0) return empty('MULTIPLIER_UNSET', bounds);

  const riskBudget = (capital * input.riskPerTradePct) / 100;
  bounds.riskBudgetUsd = toCents(riskBudget);

  /*
   * The plan's drawdown stop, expressed as money not yet lost. `currentValue`
   * below capital IS the loss taken so far, so this is the room left before the
   * stop the client agreed to. Capping a single order by it means one trade can
   * never breach the plan on its own.
   */
  const drawdownBudget = (capital * input.maxDrawdownPct) / 100 - (capital - (currentValue ?? capital));
  bounds.drawdownBudgetUsd = toCents(drawdownBudget);
  if (drawdownBudget <= 0) return empty('DRAWDOWN_BUDGET_EXHAUSTED', bounds);

  const ceiling = Math.min(
    riskBudget,
    drawdownBudget,
    bounds.platformCapUsd === null ? Number.POSITIVE_INFINITY : bounds.platformCapUsd,
  );

  const stake = toCents(ceiling);
  if (stake < MIN_STAKE_USD) return empty('BELOW_MINIMUM_STAKE', bounds);

  return {
    stake,
    notional: toCents(stake * multiplier),
    skipped: false,
    bounds,
  };
}
