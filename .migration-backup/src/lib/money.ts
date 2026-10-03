import Decimal from 'decimal.js';

/**
 * Money maths for Autopipsz.
 *
 * All balances, P/L and fee values move as Decimal, never as IEEE-754 floats.
 * Floats cannot represent 0.1 exactly; at scale that shows up as off-by-a-cent
 * equity drift, which is fatal for a platform that promises accounting
 * integrity.
 *
 * USD amounts are quantised to 2 dp (banker-free, ROUND_HALF_UP as brokers do).
 * Lot volumes and prices use 5 dp.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });

export const USD_DP = 2;
export const PRICE_DP = 5;
export const LOT_DP = 2;

export type Numeric = Decimal | string | number;

export function D(value: Numeric | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

/** Quantise to USD cents (2 dp). */
export function usd(value: Numeric): Decimal {
  return D(value).toDecimalPlaces(USD_DP, Decimal.ROUND_HALF_UP);
}

/** Quantise a lot volume. */
export function lot(value: Numeric): Decimal {
  return D(value).toDecimalPlaces(LOT_DP, Decimal.ROUND_HALF_UP);
}

/** Quantise a price. */
export function price(value: Numeric): Decimal {
  return D(value).toDecimalPlaces(PRICE_DP, Decimal.ROUND_HALF_UP);
}

/** Round for persistence to a Prisma Decimal column. */
export function toPrismaDecimal(value: Numeric, dp = USD_DP): Decimal {
  return D(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** Format for API/UI: "1,234.56". Never abbreviates — precision is the point. */
export function formatUsd(value: Numeric, opts: { sign?: boolean } = {}): string {
  const d = usd(value);
  const sign = opts.sign && d.greaterThan(0) ? '+' : '';
  return `${sign}${d.toNumber().toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(value: Numeric, dp = 2): string {
  return `${D(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString()}%`;
}

/** Sum a list of Decimals exactly. */
export function sum(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

/** Guard against division by zero anywhere a ratio is computed. */
export function safeDiv(numerator: Numeric, denominator: Numeric): Decimal {
  const d = D(denominator);
  if (d.isZero()) return new Decimal(0);
  return D(numerator).div(d);
}

/** Percentage change from baseline, in percent units (0.05 → "5.00%"). */
export function pctChange(baseline: Numeric, current: Numeric): Decimal {
  const b = D(baseline);
  if (b.isZero()) return new Decimal(0);
  return D(current).minus(b).div(b).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function isPositive(v: Numeric): boolean {
  return D(v).greaterThan(0);
}

export function isNegative(v: Numeric): boolean {
  return D(v).lessThan(0);
}

/** Clamp helper for risk limits. */
export function clamp(value: Numeric, min: Numeric, max: Numeric): Decimal {
  const v = D(value);
  if (v.lessThan(D(min))) return D(min);
  if (v.greaterThan(D(max))) return D(max);
  return v;
}

export { Decimal };
