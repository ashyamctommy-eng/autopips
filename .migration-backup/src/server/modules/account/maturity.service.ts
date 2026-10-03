/**
 * Investment maturity — the sweep, the manual close, and the console listing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS MODULE FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing in `src/` could move an `Investment` out of `ACTIVE`/`PAUSED`: the only
 * writer was the admin bot toggle (`admin.service.ts`, ACTIVE <-> PAUSED) and the
 * client's own create path (ACTIVE). `maturityDate` was written once at creation
 * and then only displayed. Because the ledger counts only ACTIVE/PAUSED capital as
 * `deployed` (`DEPLOYED_INVESTMENT_STATUSES`, `accounting/ledger.ts`), and
 * `withdrawableBalance = equity - deployedCapital - pendingWithdrawals`, a client's
 * principal stayed deployed forever and could never be withdrawn again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MATURITY IS EQUITY-NEUTRAL (read the two ledger files before changing this)
 * ─────────────────────────────────────────────────────────────────────────────
 * `accounting/ledger.ts` builds equity from aggregates, and the two capital terms
 * are a PARTITION of gross credited capital, not two independent sums:
 *
 *     deployed  = sum(Investment.capitalUsd WHERE status IN (ACTIVE, PAUSED))
 *     idle      = creditedDeposits - deployed                 (clamped, >= 0)
 *     equity    = deployed + idle + realizedPnL + unrealizedPnL - fees - withdrawals
 *               = credited - withdrawals + P/L - fees
 *
 * So the row's `capitalUsd` is not a value that "leaves" the account; the STATUS
 * is what decides which bucket it is summed into. Flipping `status` from
 * ACTIVE/PAUSED to MATURED (or CLOSED) therefore:
 *
 *   * removes `capitalUsd` from `deployed` (the `startingCapital` term), and
 *   * adds exactly the same amount to `idle` (`confirmedDeposits`), because
 *     `idle = credited - deployed`;
 *
 * and the two deltas cancel exactly. Equity is unchanged, net contributed capital
 * is unchanged, and the capital simply becomes withdrawable again. This is why the
 * transition must NOT zero `capitalUsd`: zeroing it would destroy the client's
 * capital — a $10,000 equity drop — and would also break the `credited >= deployed`
 * invariant the ledger relies on.
 *
 * The transition writes exactly `{ status, closedAt }` (`buildMaturityUpdate`).
 * `realizedPnL`, `unrealizedPnL` and `feesDeducted` stay put: they are the record
 * of what actually happened, and the ledger reads realized P/L from
 * `TradeRecord.netPnL` rather than from these columns.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY OPEN TRADES BLOCK MATURITY
 * ─────────────────────────────────────────────────────────────────────────────
 * `getAccountSnapshot` computes `unrealizedPnL` as
 * `sum(Investment.unrealizedPnL) WHERE status != CANCELLED` — i.e. a MATURED row is
 * STILL counted. If an investment were matured while a position was open, that
 * position's floating P/L would keep contributing to equity even though the
 * capital backing it is no longer deployed: the client's equity would be inflated
 * by P/L on capital the platform no longer counts as at risk, and the
 * `deployed + idle = credited` identity would be broken for the length of the
 * trade. So the sweep REFUSES (skips, records why, retries next sweep) while any
 * `TradeRecord` with status OPEN exists for the investment. It never fails the
 * whole sweep: one stuck investment must not stop every other client's maturity.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY — TWO LAYERS, BOTH REQUIRED
 * ─────────────────────────────────────────────────────────────────────────────
 * (a) DB compare-and-swap, the same discipline `decideWithdrawal` uses for
 *     withdrawals (`payments.service.ts`):
 *
 *         updateMany({ where: { id, status: { in: ['ACTIVE','PAUSED'] } },
 *                      data: { status: 'MATURED'|'CLOSED', closedAt } })
 *
 *     The transition only proceeds when `count === 1`. A second writer (another
 *     sweep, a manual close racing the worker) sees count 0 because the row is
 *     already terminal and does NOT re-audit or re-publish.
 *
 * (b) Cross-process claim, keyed on the investment: `claimOnce('maturity:<id>')`
 *     does an atomic Redis `SET NX EX`. Two worker replicas (or a manual close
 *     racing the sweep) cannot both enter the critical section; the loser gets
 *     `SKIPPED_CLAIMED` and reports it instead of acting.
 *
 * Together a second sweep is a strict no-op: the query only selects
 * ACTIVE/PAUSED rows, the claim is held by whoever acted first, and the CAS
 * refuses the transition anyway. No double audit rows, no double activity
 * events, no second equity movement.
 *
 * Pure decision logic lives in `./maturity.logic` and is re-exported here; this
 * file owns persistence, the audit trail and the client activity feed.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { usd, type Numeric } from '@/lib/money';
import { claimOnce } from '@/lib/rate-limit';
import { DEPLOYED_INVESTMENT_STATUSES } from '@/server/accounting/ledger';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { investmentRooms, makeActivity } from '@/server/modules/broker/broker.registry';
import { publishActivity } from '@/server/ws/event-bus';
import {
  AUTOMATIC_TERMINAL_STATUS,
  MANUAL_TERMINAL_STATUS,
  buildMaturityUpdate,
  decideMaturity,
  isEligibleInvestmentStatus,
  isTerminalInvestmentStatus,
  type MaturityDecision,
  type MaturityRefusalReason,
  type MaturityTerminalStatus,
  type MaturityTrigger,
} from './maturity.logic';

// The decision, the invariants and the status sets are re-exported so callers
// (and the public API surface of "maturity") have a single import site.
export {
  MATURITY_ELIGIBLE_STATUSES,
  MATURITY_TERMINAL_STATUSES,
  AUTOMATIC_TERMINAL_STATUS,
  MANUAL_TERMINAL_STATUS,
  buildMaturityUpdate,
  decideMaturity,
  isEligibleInvestmentStatus,
  isTerminalInvestmentStatus,
} from './maturity.logic';
export type {
  MaturityCandidate,
  MaturityDecision,
  MaturityRefusalReason,
  MaturityTerminalStatus,
  MaturityTrigger,
  MaturityUpdatePatch,
} from './maturity.logic';

/**
 * How long the per-investment claim is held. Long enough to cover an audit write
 * and an activity publish (milliseconds), short enough that a crash between the
 * claim and the CAS does not wedge an investment for more than one sweep.
 */
const MATURITY_CLAIM_TTL_SECONDS = 60;

/** The name every sweep/close handles the same transition through. */
type MaturityApplyOutcome = 'APPLIED' | 'SKIPPED_CLAIMED' | 'REFUSED_RACE';

export interface MaturitySweepEntry {
  investmentId: string;
  outcome: 'MATURED' | 'REFUSED' | 'SKIPPED';
  reason: MaturityRefusalReason | 'CLAIM_HELD' | 'STATUS_CHANGED' | null;
  message: string | null;
}

export interface MaturitySweepResult {
  /** Candidate rows the query returned (ACTIVE/PAUSED with maturityDate <= now). */
  examined: number;
  matured: number;
  refused: number;
  skipped: number;
  entries: MaturitySweepEntry[];
  ranAt: string;
}

/**
 * Performs the actual terminal transition for one investment.
 *
 * PRECONDITIONS HAVE ALREADY BEEN CHECKED by the caller (existence, eligibility
 * and the open-trade guard — either via `decideMaturity` in the sweep or the
 * explicit refusals in `closeInvestmentManually`). This function owns only the
 * two idempotency layers, the audit row and the activity event.
 */
async function applyMaturityTransition(args: {
  investmentId: string;
  clientUserId: string;
  previousStatus: string;
  maturityDate: Date | null;
  capitalUsd: Numeric;
  currentValUsd: Numeric;
  trigger: MaturityTrigger;
  targetStatus: MaturityTerminalStatus;
  now: Date;
  reason?: string;
  actorUserId?: string;
  actorEmail?: string;
  ip?: string | null;
}): Promise<MaturityApplyOutcome> {
  // Idempotency layer (b): one cross-process claim per investment.
  const claimed = await claimOnce(`maturity:${args.investmentId}`, MATURITY_CLAIM_TTL_SECONDS);
  if (!claimed) return 'SKIPPED_CLAIMED';

  // Idempotency layer (a): compare-and-swap on the deployed statuses. A plain
  // read-then-write would let a manual close and the sweep both transition the
  // same row; the loser sees count 0 and does nothing.
  const patch = buildMaturityUpdate({ targetStatus: args.targetStatus, closedAt: args.now });
  const { count } = await prisma.investment.updateMany({
    where: { id: args.investmentId, status: { in: [...DEPLOYED_INVESTMENT_STATUSES] } },
    data: patch,
  });
  if (count !== 1) return 'REFUSED_RACE';

  // Audit. Money fields are the same Decimal-derived cents the UI shows; the
  // FULL capital record stays on the row untouched (see the header).
  const details: Record<string, string | number | boolean | null> = {
    investmentId: args.investmentId,
    previousStatus: args.previousStatus,
    status: args.targetStatus,
    maturityDate: args.maturityDate ? args.maturityDate.toISOString() : null,
    capitalUsd: usd(args.capitalUsd).toNumber(),
    currentValUsd: usd(args.currentValUsd).toNumber(),
    trigger: args.trigger,
    automatic: args.trigger === 'AUTOMATIC',
  };
  if (args.trigger === 'MANUAL') {
    // Distinguishes an operator close from an automatic maturity in the trail:
    // a different action (INVESTMENT_CLOSED) AND explicit reason/actor fields.
    details.reason = args.reason ?? null;
    details.actorUserId = args.actorUserId ?? null;
    details.actorEmail = args.actorEmail ?? null;
  }

  if (args.trigger === 'MANUAL') {
    await recordAudit({
      action: AUDIT.INVESTMENT_CLOSED,
      userId: args.clientUserId,
      ipAddress: args.ip ?? null,
      details: details as unknown as Prisma.InputJsonValue,
    });
  } else {
    await recordAuditSafe({
      action: AUDIT.INVESTMENT_MATURED,
      userId: args.clientUserId,
      ipAddress: args.ip ?? null,
      details: details as unknown as Prisma.InputJsonValue,
    });
  }

  // Client feed. `investmentRooms` targets the client's investment room plus the
  // admin room, so the owner sees their principal released and the console sees
  // the sweep action. Best-effort: publishActivity never throws.
  const message =
    args.trigger === 'MANUAL'
      ? `Investment closed by an operator: ${args.reason ?? 'no reason given'}. Capital is back in the client's available balance.`
      : 'Investment reached maturity. Capital is back in the client\'s available balance.';
  await publishActivity(
    makeActivity(
      args.trigger === 'MANUAL' ? 'INVESTMENT_CLOSED' : 'INVESTMENT_MATURED',
      message,
      args.trigger === 'MANUAL' ? 'info' : 'success',
      {
        investmentId: args.investmentId,
        previousStatus: args.previousStatus,
        status: args.targetStatus,
        trigger: args.trigger,
        capitalUsd: usd(args.capitalUsd).toNumber(),
        currentValUsd: usd(args.currentValUsd).toNumber(),
        ...(args.trigger === 'MANUAL' ? { reason: args.reason ?? null } : {}),
      },
      investmentRooms(args.investmentId),
    ),
  );

  return 'APPLIED';
}

/**
 * Sweeps every investment that is due and still deployed.
 *
 * `now` is injectable so a test can pin the clock. The query is served by the
 * `@@index([maturityDate])` added with the P0 migration.
 *
 * One bad investment never aborts the sweep: each row is decided and processed
 * independently, the outcome is recorded per row, and the loop continues.
 */
export async function processMaturedInvestments(now: Date = new Date()): Promise<MaturitySweepResult> {
  const candidates = await prisma.investment.findMany({
    where: {
      status: { in: [...DEPLOYED_INVESTMENT_STATUSES] },
      maturityDate: { lte: now },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      maturityDate: true,
      capitalUsd: true,
      currentValUsd: true,
      trades: { where: { status: 'OPEN' }, select: { id: true } },
    },
    orderBy: { maturityDate: 'asc' },
  });

  const entries: MaturitySweepEntry[] = [];

  for (const row of candidates) {
    const openTrades = row.trades.length;
    const decision = decideMaturity(
      { id: row.id, status: row.status, maturityDate: row.maturityDate, openTrades },
      now,
    );

    if (decision.action === 'REFUSE') {
      // Record the reason and move on: one stuck investment (most often an open
      // position) must never stop every other client's capital from maturing.
      // The next sweep retries it.
      console.warn(
        `[maturity] deferred ${row.id} (${decision.reason}): ${decision.message}`,
      );
      entries.push({
        investmentId: row.id,
        outcome: 'REFUSED',
        reason: decision.reason,
        message: decision.message,
      });
      continue;
    }

    const outcome = await applyMaturityTransition({
      investmentId: row.id,
      clientUserId: row.userId,
      previousStatus: row.status,
      maturityDate: row.maturityDate,
      capitalUsd: row.capitalUsd,
      currentValUsd: row.currentValUsd,
      trigger: 'AUTOMATIC',
      targetStatus: AUTOMATIC_TERMINAL_STATUS,
      now,
    });

    if (outcome === 'APPLIED') {
      entries.push({
        investmentId: row.id,
        outcome: 'MATURED',
        reason: null,
        message: decision.message,
      });
    } else {
      entries.push({
        investmentId: row.id,
        outcome: 'SKIPPED',
        reason: outcome === 'SKIPPED_CLAIMED' ? 'CLAIM_HELD' : 'STATUS_CHANGED',
        message:
          outcome === 'SKIPPED_CLAIMED'
            ? 'Another maturity process already claimed this investment.'
            : 'The investment status changed while the sweep was running; it was left for the next sweep.',
      });
    }
  }

  return {
    examined: candidates.length,
    matured: entries.filter((entry) => entry.outcome === 'MATURED').length,
    refused: entries.filter((entry) => entry.outcome === 'REFUSED').length,
    skipped: entries.filter((entry) => entry.outcome === 'SKIPPED').length,
    entries,
    ranAt: now.toISOString(),
  };
}

export interface ManualCloseResult {
  id: string;
  status: MaturityTerminalStatus;
  previousStatus: string;
  closedAt: string;
  reason: string;
}

/**
 * Operator-driven close/mature of one investment — the ADMIN manual path.
 *
 * Deliberately NOT date-gated: an operator may close early for a documented
 * reason (a client request, a broker migration, a fraud hold). What is NOT
 * optional is the same accounting guard the sweep uses: an OPEN position blocks
 * closure, because maturing with a live position would leave that position's
 * floating P/L counted against non-deployed capital (see file header).
 *
 * Uses the SAME `applyMaturityTransition` as the sweep, so the CAS, the claim and
 * the capital-preserving patch cannot drift between the two entry points. The
 * audit action differs (INVESTMENT_CLOSED, with `trigger: 'MANUAL'`, the reason
 * and the operator named) so the trail never confuses a manual close with an
 * automatic maturity.
 */
export async function closeInvestmentManually(input: {
  investmentId: string;
  reason: string;
  actorUserId: string;
  actorEmail: string;
  ip: string | null;
}): Promise<ManualCloseResult> {
  const row = await prisma.investment.findUnique({
    where: { id: input.investmentId },
    select: {
      id: true,
      userId: true,
      status: true,
      maturityDate: true,
      capitalUsd: true,
      currentValUsd: true,
      trades: { where: { status: 'OPEN' }, select: { id: true } },
    },
  });

  if (!row) {
    throw ApiError.notFound('Investment not found.');
  }
  if (isTerminalInvestmentStatus(row.status)) {
    throw ApiError.conflict(
      `Investment ${row.id} is already ${row.status}. A settled investment cannot be closed again.`,
    );
  }
  if (!isEligibleInvestmentStatus(row.status)) {
    throw ApiError.conflict(
      `Investment ${row.id} is ${row.status}; only an ACTIVE or PAUSED investment can be closed.`,
    );
  }
  if (row.trades.length > 0) {
    throw ApiError.conflict(
      `Investment ${row.id} still has ${row.trades.length} open position(s). ` +
        'Close or force-close every position first; maturing now would count unrealized P/L against capital that is no longer deployed.',
    );
  }

  const now = new Date();
  const outcome = await applyMaturityTransition({
    investmentId: row.id,
    clientUserId: row.userId,
    previousStatus: row.status,
    maturityDate: row.maturityDate,
    capitalUsd: row.capitalUsd,
    currentValUsd: row.currentValUsd,
    trigger: 'MANUAL',
    targetStatus: MANUAL_TERMINAL_STATUS,
    now,
    reason: input.reason,
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    ip: input.ip,
  });

  if (outcome === 'SKIPPED_CLAIMED') {
    throw ApiError.conflict(
      `Investment ${row.id} is already being closed by the automatic maturity sweep. Reload and check its status.`,
    );
  }
  if (outcome === 'REFUSED_RACE') {
    throw ApiError.conflict(
      `Investment ${row.id} changed status while you were closing it. Reload and check its current status.`,
    );
  }

  return {
    id: row.id,
    status: MANUAL_TERMINAL_STATUS,
    previousStatus: row.status,
    closedAt: now.toISOString(),
    reason: input.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Admin console listing                                                       */
/* -------------------------------------------------------------------------- */

/** Prisma `InvestmentStatus` members, as a runtime-checkable tuple for zod. */
export const INVESTMENT_STATUS_VALUES = [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'MATURED',
  'CANCELLED',
  'CLOSED',
] as const;

export type InvestmentStatusValue = (typeof INVESTMENT_STATUS_VALUES)[number];

export interface AdminInvestmentListItem {
  id: string;
  userId: string;
  userEmail: string;
  planId: string;
  planName: string;
  capitalUsd: number;
  currentValUsd: number;
  realizedPnL: number;
  unrealizedPnL: number;
  feesDeducted: number;
  status: string;
  startDate: string | null;
  maturityDate: string | null;
  closedAt: string | null;
  createdAt: string;
  /** OPEN TradeRecord rows for this investment right now. */
  openTrades: number;
  /**
   * True when an OPEN position forbids closure. This is the accounting guard the
   * sweep and the manual close both enforce, surfaced so an operator can see it
   * BEFORE clicking close.
   */
  blocksClosure: boolean;
  /** The maturity date has elapsed and the investment is still deployed. */
  maturityDue: boolean;
  /** The sweep's verdict for this row right now. */
  maturityDecision: MaturityDecision;
}

export interface AdminInvestmentListResult {
  items: AdminInvestmentListItem[];
  nextCursor: string | null;
}

function num(value: Prisma.Decimal | number | string): number {
  return usd(String(value)).toNumber();
}

/**
 * Platform-wide investment list for the admin console.
 *
 * Every field is read from persisted rows; `blocksClosure` and `maturityDue` are
 * derived by the same `decideMaturity` the sweep uses, so the console shows the
 * operator exactly what the worker would do. Newest first, cursor-paginated on
 * the investment id.
 */
export async function listInvestmentsForAdmin(opts: {
  status?: InvestmentStatusValue;
  take?: number;
  cursor?: string;
}): Promise<AdminInvestmentListResult> {
  const take = Math.min(Math.max(opts.take ?? 50, 1), 100);

  const rows = await prisma.investment.findMany({
    where: opts.status ? { status: opts.status } : {},
    select: {
      id: true,
      userId: true,
      planId: true,
      capitalUsd: true,
      currentValUsd: true,
      realizedPnL: true,
      unrealizedPnL: true,
      feesDeducted: true,
      status: true,
      startDate: true,
      maturityDate: true,
      closedAt: true,
      createdAt: true,
      plan: { select: { name: true } },
      user: { select: { email: true } },
      trades: { where: { status: 'OPEN' }, select: { id: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const now = new Date();

  const items = page.map((row): AdminInvestmentListItem => {
    const openTrades = row.trades.length;
    const decision = decideMaturity(
      { id: row.id, status: row.status, maturityDate: row.maturityDate, openTrades },
      now,
    );
    return {
      id: row.id,
      userId: row.userId,
      userEmail: row.user.email,
      planId: row.planId,
      planName: row.plan.name,
      capitalUsd: num(row.capitalUsd),
      currentValUsd: num(row.currentValUsd),
      realizedPnL: num(row.realizedPnL),
      unrealizedPnL: num(row.unrealizedPnL),
      feesDeducted: num(row.feesDeducted),
      status: row.status,
      startDate: row.startDate?.toISOString() ?? null,
      maturityDate: row.maturityDate?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      openTrades,
      blocksClosure: openTrades > 0,
      maturityDue:
        row.maturityDate !== null &&
        row.maturityDate.getTime() <= now.getTime() &&
        isEligibleInvestmentStatus(row.status),
      maturityDecision: decision,
    };
  });

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
