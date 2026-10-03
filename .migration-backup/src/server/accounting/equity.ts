import { D, toPrismaDecimal, usd, type Numeric, Decimal } from '@/lib/money';

/**
 * ACCOUNTING INTEGRITY — business directive #3.
 *
 *   Equity = Starting Capital
 *          + Realized P/L
 *          + Unrealized P/L
 *          − Deducted Fees
 *          − Withdrawals
 *          + Confirmed Deposits
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE TWO CAPITAL TERMS ARE DISAMBIGUATED (read this before changing them)
 * ─────────────────────────────────────────────────────────────────────────────
 * The formula has two additive capital terms. If both were fed "all money the
 * client ever sent us", the same dollar would be counted twice: deposit $1,000,
 * allocate it to a strategy, and equity would read $2,000 — the client could
 * then withdraw $1,000 of thin air.
 *
 * So the two terms partition contributed capital, they do not overlap:
 *
 *   Starting Capital   = capital currently DEPLOYED with a strategy
 *                        (Σ Investment.capitalUsd WHERE status ∈ {ACTIVE, PAUSED})
 *   Confirmed Deposits = confirmed deposits NOT yet deployed
 *                        (= gross credited deposits − deployed capital)
 *
 * Note the two terms together equal GROSS credited deposits; the `− Withdrawals`
 * term is what turns that into NET contributed capital. Getting this wrong is
 * subtle and expensive: building the idle-cash term from already-net capital and
 * then subtracting withdrawals again debits every withdrawal twice. Substituting:
 *
 *   Equity = (deployed) + P/L − fees − withdrawals + (credited − deployed)
 *          = credited − withdrawals + Realized P/L + Unrealized P/L − Deducted Fees
 *          = net contributed capital + Realized P/L + Unrealized P/L − Deducted Fees
 *
 * which is the standard managed-account equity identity. Moving capital between
 * the two buckets — depositing, then investing, or closing an investment and
 * returning its capital to idle — is equity-NEUTRAL. Both invariants are asserted
 * by the verification suite.
 *
 * This module is pure: it takes already-fetched, already-verified ledger rows
 * and performs the arithmetic. It never invents a number. Every input traces
 * back to one of exactly three authorities:
 *
 *   1. Investment.capitalUsd   — funded by a FINISHED deposit (NOWPayments IPN)
 *   2. TradeRecord.netPnL      — written from MetaApi deal events only
 *   3. Deposit / Withdrawal    — status-advanced by verified IPN callbacks or
 *                                an ADMIN approval recorded in AuditLog
 *
 * Money is Decimal throughout. Float arithmetic is never used.
 */

export const EQUITY_FORMULA =
  'Equity = Starting Capital + Realized P/L + Unrealized P/L - Deducted Fees - Withdrawals + Confirmed Deposits';

/** Payment statuses that represent money we have actually received. */
export const CREDITED_PAYMENT_STATUSES = ['CONFIRMED', 'FINISHED'] as const;
/** Payment statuses that represent money we have actually paid out. */
export const DEBITED_PAYMENT_STATUSES = ['FINISHED'] as const;

export interface EquityInputs {
  /**
   * Capital currently DEPLOYED with a strategy:
   * Σ Investment.capitalUsd WHERE status ∈ {ACTIVE, PAUSED}.
   * Excludes CLOSED/MATURED/CANCELLED investments — their capital is idle again.
   */
  startingCapital: Numeric;
  /** Σ TradeRecord.netPnL for CLOSED trades. Broker-sourced only. */
  realizedPnL: Numeric;
  /** Σ Investment.unrealizedPnL, sourced from live MetaApi positions. */
  unrealizedPnL: Numeric;
  /** Σ Investment.feesDeducted (management + performance fees actually taken). */
  deductedFees: Numeric;
  /** Σ Withdrawal.amountUsd where status = FINISHED. */
  withdrawals: Numeric;
  /**
   * Confirmed deposits NOT yet deployed to a strategy (idle cash).
   * MUST NOT be the gross sum of all deposits — see the disambiguation above.
   */
  confirmedDeposits: Numeric;
  /**
   * Denominator for `netReturnPct`. Defaults to `startingCapital`.
   * The ledger passes net contributed capital, because "return on the money I
   * put in" is what a client expects to see.
   */
  returnBase?: Numeric;
}

export interface EquityBreakdown {
  startingCapital: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  deductedFees: Decimal;
  withdrawals: Decimal;
  confirmedDeposits: Decimal;
  /** Signed sum of every component. */
  equity: Decimal;
  /** Equity net of the capital that was deposited (i.e. total P/L). */
  netProfit: Decimal;
  /** netProfit / returnBase, as a percentage. Zero-guarded. */
  netReturnPct: Decimal;
  /** Realized + unrealized, before fees. */
  grossPnL: Decimal;
  /** startingCapital + confirmedDeposits − withdrawals = net contributed capital. */
  netContributedCapital: Decimal;
  formula: string;
}

function dec(v: Numeric | null | undefined, dp = 2): Decimal {
  return toPrismaDecimal(D(v), dp);
}

/**
 * Compute the account equity breakdown from verified ledger inputs.
 */
export function computeEquity(input: EquityInputs): EquityBreakdown {
  const startingCapital = dec(input.startingCapital);
  const realizedPnL = dec(input.realizedPnL);
  const unrealizedPnL = dec(input.unrealizedPnL);
  const deductedFees = dec(input.deductedFees);
  const withdrawals = dec(input.withdrawals);
  const confirmedDeposits = dec(input.confirmedDeposits);

  const equity = usd(
    startingCapital
      .plus(realizedPnL)
      .plus(unrealizedPnL)
      .minus(deductedFees)
      .minus(withdrawals)
      .plus(confirmedDeposits),
  );

  const grossPnL = usd(realizedPnL.plus(unrealizedPnL));

  // Net profit is the growth of the account, independent of how much capital is
  // in it — so a deposit does not inflate it and a withdrawal does not deflate it.
  const netProfit = usd(grossPnL.minus(deductedFees));

  const returnBase = dec(input.returnBase ?? input.startingCapital);
  const netReturnPct = returnBase.isZero()
    ? new Decimal(0)
    : netProfit.div(returnBase).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  return {
    startingCapital,
    realizedPnL,
    unrealizedPnL,
    deductedFees,
    withdrawals,
    confirmedDeposits,
    equity,
    netProfit,
    netReturnPct,
    grossPnL,
    netContributedCapital: usd(startingCapital.plus(confirmedDeposits).minus(withdrawals)),
    formula: EQUITY_FORMULA,
  };
}

/**
 * Assert an internally-computed investment snapshot is consistent with the
 * formula. Used by the broker sync worker and by tests — a mismatch means a
 * trade was booked without updating its investment, which must never ship.
 *
 * STRICT: any delta of a whole cent or more is a violation. A `>` comparison
 * would let a one-cent-per-event drift pass forever and compound invisibly,
 * which is exactly the failure class this guard exists to catch.
 */
export function assertEquityConsistency(input: EquityInputs, reportedEquity: Numeric): void {
  const { equity } = computeEquity(input);
  const reported = dec(reportedEquity);
  const delta = equity.minus(reported).abs();
  if (delta.greaterThanOrEqualTo('0.01')) {
    throw new Error(
      `Accounting integrity violation: formula yields ${equity.toString()} but stored equity is ${reported.toString()} (delta ${delta.toString()}). ${EQUITY_FORMULA}`,
    );
  }
}

/**
 * Available balance for a withdrawal request: equity minus capital that is
 * locked in ACTIVE investments. Prevents a client from withdrawing funds that
 * are currently deployed with the broker.
 */
export function computeWithdrawableBalance(args: {
  equity: Decimal;
  activeCapital: Numeric;
  pendingWithdrawals: Numeric;
  minimumReserve?: Numeric;
}): Decimal {
  const { equity, activeCapital, pendingWithdrawals, minimumReserve = 0 } = args;
  const available = equity.minus(dec(activeCapital)).minus(dec(pendingWithdrawals)).minus(dec(minimumReserve));
  return usd(available.lessThan(0) ? 0 : available);
}
