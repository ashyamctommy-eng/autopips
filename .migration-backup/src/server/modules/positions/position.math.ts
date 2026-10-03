import { D, usd, type Decimal, type Numeric } from '@/lib/money';

/**
 * P&L arithmetic for internally-executed positions. PURE — no I/O, no clock.
 *
 * THE MODEL (documented once, here)
 * ---------------------------------
 * The platform is the counterparty, so the numbers must be defined explicitly:
 *
 *   notional = stake × multiplier
 *   pnl      = notional × ((price − entry) / entry) × (BUY ? 1 : −1)
 *   pnl      is CLAMPED at −stake
 *
 * `stake` is the money at risk and the MAXIMUM loss — the same doctrine the
 * managed-trading path already settled (risk is sized in dollars at risk, the
 * stake). Without the clamp a SELL into a doubling market would hand the client a
 * loss larger than they committed: a liability the platform could never collect.
 * The clamp makes the worst case exactly the stake, which is what the UI promises.
 *
 * Everything is Decimal; no float ever touches a balance.
 */

export type PositionSideValue = 'BUY' | 'SELL';

export interface PositionPnlInput {
  side: PositionSideValue;
  /** Money at risk (the maximum loss). */
  stake: Numeric;
  /** Exposure multiple applied to the stake. */
  multiplier: Numeric;
  entryPrice: Numeric;
  currentPrice: Numeric;
}

/**
 * Mark-to-market P&L for one position, in USD, 2dp, clamped at −stake.
 * Throws on structurally invalid inputs rather than silently returning 0.
 */
export function computePositionPnl(input: PositionPnlInput): Decimal {
  const stake = D(input.stake);
  const multiplier = D(input.multiplier);
  const entry = D(input.entryPrice);
  const current = D(input.currentPrice);

  if (!stake.isFinite() || stake.lessThan(0)) {
    throw new Error('Position stake must be a non-negative finite number.');
  }
  if (!multiplier.isFinite() || multiplier.lessThanOrEqualTo(0)) {
    throw new Error('Position multiplier must be positive and finite.');
  }
  if (!entry.isFinite() || entry.lessThanOrEqualTo(0)) {
    throw new Error('Position entry price must be positive and finite.');
  }
  if (!current.isFinite() || current.lessThanOrEqualTo(0)) {
    throw new Error('Position current price must be positive and finite.');
  }

  const notional = stake.times(multiplier);
  const movePct = current.minus(entry).div(entry);
  const direction = input.side === 'BUY' ? 1 : -1;
  const raw = notional.times(movePct).times(direction);

  const lossFloor = stake.negated();
  const clamped = raw.lessThan(lossFloor) ? lossFloor : raw;

  return usd(clamped);
}

export type PositionExitTrigger = 'STOP_LOSS' | 'TAKE_PROFIT' | null;

/**
 * Which protective level, if any, this price has crossed.
 *
 * STOP_LOSS is checked BEFORE TAKE_PROFIT on purpose: if a gap lands beyond both
 * levels, the conservative outcome (a loss) is the one booked.
 */
export function positionExitTrigger(input: {
  side: PositionSideValue;
  stopLoss?: Numeric | null;
  takeProfit?: Numeric | null;
  price: Numeric;
}): PositionExitTrigger {
  const price = D(input.price);
  const stopLoss =
    input.stopLoss === null || input.stopLoss === undefined ? null : D(input.stopLoss);
  const takeProfit =
    input.takeProfit === null || input.takeProfit === undefined ? null : D(input.takeProfit);

  if (input.side === 'BUY') {
    if (stopLoss !== null && price.lessThanOrEqualTo(stopLoss)) return 'STOP_LOSS';
    if (takeProfit !== null && price.greaterThanOrEqualTo(takeProfit)) return 'TAKE_PROFIT';
    return null;
  }

  if (stopLoss !== null && price.greaterThanOrEqualTo(stopLoss)) return 'STOP_LOSS';
  if (takeProfit !== null && price.lessThanOrEqualTo(takeProfit)) return 'TAKE_PROFIT';
  return null;
}

/**
 * Directional sanity for a protective pair: a BUY must stop out BELOW its entry
 * and target ABOVE it (and the mirror for a SELL). Rejecting a crossed pair is
 * worth the friction — otherwise a stop-loss above entry on a BUY fires
 * immediately at a loss the client never intended.
 */
export function isProtectivePairSane(input: {
  side: PositionSideValue;
  entryPrice: Numeric;
  stopLoss?: Numeric | null;
  takeProfit?: Numeric | null;
}): boolean {
  const entry = D(input.entryPrice);
  const stopLoss =
    input.stopLoss === null || input.stopLoss === undefined ? null : D(input.stopLoss);
  const takeProfit =
    input.takeProfit === null || input.takeProfit === undefined ? null : D(input.takeProfit);

  if (stopLoss !== null && stopLoss.lessThanOrEqualTo(0)) return false;
  if (takeProfit !== null && takeProfit.lessThanOrEqualTo(0)) return false;

  if (input.side === 'BUY') {
    if (stopLoss !== null && stopLoss.greaterThanOrEqualTo(entry)) return false;
    if (takeProfit !== null && takeProfit.lessThanOrEqualTo(entry)) return false;
  } else {
    if (stopLoss !== null && stopLoss.lessThanOrEqualTo(entry)) return false;
    if (takeProfit !== null && takeProfit.greaterThanOrEqualTo(entry)) return false;
  }
  return true;
}
