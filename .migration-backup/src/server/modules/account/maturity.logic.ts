/**
 * Investment maturity — PURE decision logic.
 *
 * WHY THIS FILE IS SEPARATE FROM `maturity.service.ts`
 * The rule "may this investment leave ACTIVE/PAUSED?" is the part of the
 * maturity path that must never be wrong, and it is exactly the part that does
 * not need a database: it reads the investment's status, its maturity date and
 * whether it still has open positions, and returns a verdict. Keeping it free of
 * Prisma, Redis, the audit table, the event bus and the broker registry means the
 * verdict can be unit-tested directly (`tests/investment-maturity.test.ts`)
 * without a live Postgres and without loading the broker SDK.
 *
 * `maturity.service.ts` re-exports everything here, so callers have one import
 * surface for "maturity".
 *
 * THE ONE INVARIANT THIS FILE ENCODES
 * A terminal transition NEVER touches money fields. `capitalUsd`,
 * `realizedPnL`, `unrealizedPnL` and `feesDeducted` are the record of what
 * happened to the client's capital; maturity changes only WHERE the capital is
 * counted (deployed vs idle), never how much there is. See
 * `buildMaturityUpdate` and the long reasoning comment at the top of
 * `maturity.service.ts`.
 */

/** Investment statuses whose capital is still DEPLOYED with the broker. */
export const MATURITY_ELIGIBLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/**
 * Investment statuses that are final: once here, an investment has settled and
 * must never be re-opened or matured again.
 */
export const MATURITY_TERMINAL_STATUSES = ['MATURED', 'CLOSED', 'CANCELLED'] as const;

export type MaturityEligibleStatus = (typeof MATURITY_ELIGIBLE_STATUSES)[number];
export type MaturityTerminalStatus = (typeof MATURITY_TERMINAL_STATUSES)[number];

/** The terminal status an automatic sweep writes. */
export const AUTOMATIC_TERMINAL_STATUS = 'MATURED' as const;
/** The terminal status an operator's manual close writes. */
export const MANUAL_TERMINAL_STATUS = 'CLOSED' as const;

export type MaturityTrigger = 'AUTOMATIC' | 'MANUAL';

/** Every way the decision can refuse to close an investment. */
export type MaturityRefusalReason =
  | 'ALREADY_TERMINAL'
  | 'NO_MATURITY_DATE'
  | 'NOT_DUE'
  | 'OPEN_TRADES';

export interface MaturityCandidate {
  /** Investment id, when known — used in the operator-facing message. */
  id?: string;
  status: string;
  maturityDate: Date | null;
  /**
   * Number of `TradeRecord` rows with status OPEN for this investment. The
   * caller must count them; the decision does not trust a cached flag.
   */
  openTrades: number;
}

export type MaturityDecision =
  | {
      action: 'MATURE';
      status: typeof AUTOMATIC_TERMINAL_STATUS;
      reason: null;
      message: string;
    }
  | {
      action: 'REFUSE';
      status: null;
      reason: MaturityRefusalReason;
      message: string;
    };

export function isTerminalInvestmentStatus(status: string): boolean {
  return (MATURITY_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isEligibleInvestmentStatus(status: string): boolean {
  return (MATURITY_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The maturity verdict for one investment.
 *
 * Order matters and is deliberate:
 *   1. TERMINAL first — an already-settled investment is refused unconditionally;
 *      its maturity date is irrelevant and reporting it as "due" would invite a
 *      second transition.
 *   2. NO maturity date / not yet due — the plan's term has not elapsed.
 *   3. OPEN trades — the hard accounting guard. `equity` includes
 *      `sum(Investment.unrealizedPnL)` for every non-CANCELLED investment, so
 *      closing an investment while a position is still open would keep counting
 *      that position's floating P/L against an account whose capital is no longer
 *      deployed. The investment is SKIPPED (not failed) and retried on a later
 *      sweep, once the broker has closed the position and the sync has rolled the
 *      result up.
 *
 * `now` is injected so the behaviour is deterministic in tests.
 */
export function decideMaturity(
  candidate: MaturityCandidate,
  now: Date = new Date(),
): MaturityDecision {
  const label = candidate.id ? `Investment ${candidate.id}` : 'This investment';

  if (isTerminalInvestmentStatus(candidate.status)) {
    return {
      action: 'REFUSE',
      status: null,
      reason: 'ALREADY_TERMINAL',
      message: `${label} is already ${candidate.status} and cannot be closed again.`,
    };
  }

  if (!isEligibleInvestmentStatus(candidate.status)) {
    // PENDING (or any future non-deployed status) has no deployed capital to
    // return, so it is not mature-able: report it as terminal rather than
    // inventing a transition the ledger does not model.
    return {
      action: 'REFUSE',
      status: null,
      reason: 'ALREADY_TERMINAL',
      message: `${label} is ${candidate.status}; only an ACTIVE or PAUSED investment can be matured.`,
    };
  }

  if (candidate.maturityDate === null) {
    return {
      action: 'REFUSE',
      status: null,
      reason: 'NO_MATURITY_DATE',
      message: `${label} has no maturity date, so there is no due date to sweep against.`,
    };
  }

  if (candidate.maturityDate.getTime() > now.getTime()) {
    return {
      action: 'REFUSE',
      status: null,
      reason: 'NOT_DUE',
      message: `${label} matures on ${candidate.maturityDate.toISOString()}, which is still in the future.`,
    };
  }

  if (candidate.openTrades > 0) {
    return {
      action: 'REFUSE',
      status: null,
      reason: 'OPEN_TRADES',
      message:
        `${label} still has ${candidate.openTrades} open position(s). ` +
        'Maturity is deferred until the broker has closed every position, so unrealized P/L is never counted against idle capital.',
    };
  }

  return {
    action: 'MATURE',
    status: AUTOMATIC_TERMINAL_STATUS,
    reason: null,
    message: `${label} matured on ${candidate.maturityDate.toISOString()}.`,
  };
}

export interface MaturityUpdatePatch {
  status: MaturityTerminalStatus;
  closedAt: Date;
}

/**
 * The ONLY columns a maturity/close transition may write.
 *
 * Returned as a value (rather than inlined into the Prisma call) so the "does
 * not mutate capitalUsd" claim is a testable, reviewable fact: the object has
 * exactly two keys and neither is a money field. `capitalUsd` stays on the row;
 * the status flip alone is what moves it out of `deployed` and back into `idle`
 * (`idle = credited - deployed`), which is equity-neutral by construction.
 */
export function buildMaturityUpdate(input: {
  targetStatus?: MaturityTerminalStatus;
  closedAt: Date;
}): MaturityUpdatePatch {
  return {
    status: input.targetStatus ?? AUTOMATIC_TERMINAL_STATUS,
    closedAt: input.closedAt,
  };
}
