import type { InternalPositionDTO } from '@/types/api';

/**
 * Order ticket — the client half of `POST /api/v1/positions`.
 *
 * The server is the authority: it re-validates everything here, prices the fill
 * itself and refuses the request outright when `EXECUTION_MODE` is not
 * `internal`. This module exists so the user is told *before* they click, in the
 * same words the server would use, rather than after a round trip.
 *
 * THE STAKE IS THE MAXIMUM LOSS. A Deriv multiplier contract is bought with a
 * stake and cannot lose more than it; `multiplier` scales the exposure and the
 * rate the P/L moves at, never the money at risk. The ticket therefore states the
 * stake as the money at risk and shows the notional separately, so the two are
 * never confused for one another.
 */

export type TicketSide = 'BUY' | 'SELL';

/**
 * Server limits, mirrored. They are declared here because the service that owns
 * them imports Prisma and cannot be reached from a client component;
 * `tests/order-ticket.test.ts` asserts this copy still equals the original, so a
 * limit changed on the server fails CI rather than silently disagreeing with the
 * form the user is typing into.
 */
export const TICKET_LIMITS = {
  /** `POSITION_MIN_STAKE_USD` */
  minStakeUsd: 1,
  /** `POSITION_MAX_STAKE_USD` */
  maxStakeUsd: 25_000,
  /** `POSITION_MAX_MULTIPLIER` */
  maxMultiplier: 100,
} as const;

/** `assertStake` rejects more than 2 decimal places on the server. */
export const MAX_STAKE_DECIMAL_PLACES = 2;

export interface TicketInput {
  side: TicketSide;
  stakeUsd: number;
  multiplier: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface TicketContext {
  /**
   * Live market price the levels are judged against. `null` when no quote has
   * arrived — the level checks are then skipped rather than guessed, and the
   * server still has the final word.
   */
  referencePrice: number | null;
  /** Ledger withdrawable cash the stake is reserved from. `null` = unknown. */
  availableUsd: number | null;
}

export interface TicketErrors {
  stake?: string;
  multiplier?: string;
  stopLoss?: string;
  takeProfit?: string;
}

/** Decimal places in a number's own representation — "1.005" is 3, not 2. */
function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();
  const exponent = text.indexOf('e-');
  if (exponent !== -1) return Number(text.slice(exponent + 2));
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function money(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Everything wrong with the ticket, or an empty object.
 *
 * Returning a field map (rather than throwing on the first problem) lets the form
 * mark each input at once, which is what a person editing three fields expects.
 */
export function validateTicket(input: TicketInput, context: TicketContext): TicketErrors {
  const errors: TicketErrors = {};

  const { stakeUsd, multiplier, stopLoss, takeProfit } = input;

  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) {
    errors.stake = 'Enter a stake greater than zero.';
  } else if (decimalPlaces(stakeUsd) > MAX_STAKE_DECIMAL_PLACES) {
    errors.stake = `A stake may have at most ${MAX_STAKE_DECIMAL_PLACES} decimal places.`;
  } else if (stakeUsd < TICKET_LIMITS.minStakeUsd) {
    errors.stake = `The minimum stake is ${money(TICKET_LIMITS.minStakeUsd)}.`;
  } else if (stakeUsd > TICKET_LIMITS.maxStakeUsd) {
    errors.stake = `The maximum stake is ${money(TICKET_LIMITS.maxStakeUsd)}.`;
  } else if (context.availableUsd !== null && stakeUsd > context.availableUsd) {
    errors.stake = `That is more than your available cash of ${money(context.availableUsd)}.`;
  }

  if (!Number.isFinite(multiplier) || multiplier < 1) {
    errors.multiplier = 'The multiplier must be at least 1.';
  } else if (multiplier > TICKET_LIMITS.maxMultiplier) {
    errors.multiplier = `The multiplier may not exceed ${TICKET_LIMITS.maxMultiplier}.`;
  }

  // A level on the wrong side of the market would be filled by the next tick —
  // a stop placed above the price on a BUY, or a target below it, is a typo, not
  // an order. The reference is the live quote; without one the check is skipped.
  const reference = context.referencePrice;
  const judgesLevels = reference !== null && Number.isFinite(reference);

  const checkLevel = (
    kind: 'stopLoss' | 'takeProfit',
    value: number | null,
    label: string,
  ): void => {
    if (value === null) return;
    if (!Number.isFinite(value) || value <= 0) {
      errors[kind] = 'Enter a positive price, or leave this blank.';
      return;
    }
    if (!judgesLevels) return;
    const mustBeBelow = kind === 'stopLoss' ? input.side === 'BUY' : input.side === 'SELL';
    const direction = mustBeBelow ? 'below' : 'above';
    const wrongSide = mustBeBelow ? value >= reference : value <= reference;
    if (wrongSide) {
      errors[kind] = `A ${label} on a ${input.side} must be ${direction} the current price of ${reference}.`;
    }
  };

  checkLevel('stopLoss', stopLoss, 'stop loss');
  checkLevel('takeProfit', takeProfit, 'take profit');

  return errors;
}

/** True when nothing is wrong — the ticket can be submitted. */
export function isTicketValid(errors: TicketErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Notional exposure = stake × multiplier. `null` when either is unusable, so the
 * readout can say "—" instead of printing a number built from a blank field.
 */
export function exposureNotional(stakeUsd: number, multiplier: number): number | null {
  if (!Number.isFinite(stakeUsd) || !Number.isFinite(multiplier)) return null;
  if (stakeUsd <= 0 || multiplier <= 0) return null;
  return stakeUsd * multiplier;
}

/** Open positions the engine booked internally, newest first. */
export function sortInternalPositions(positions: readonly InternalPositionDTO[]): InternalPositionDTO[] {
  return [...positions].sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}
