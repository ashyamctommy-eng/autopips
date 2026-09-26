import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

/**
 * Immutable audit logger.
 *
 * Every state transition that touches money, identity, or the broker must be
 * recorded here. The table is append-only by convention: there is deliberately
 * no update or delete helper in this module.
 *
 * `action` values are namespaced SCREAMING_SNAKE strings so they can be
 * filtered and alerted on:
 *   AUTH_*, KYC_*, DEPOSIT_*, WITHDRAWAL_*, BROKER_*, RISK_*, PLAN_*, ADMIN_*
 */

export const AUDIT = {
  // auth
  AUTH_REGISTERED: 'AUTH_REGISTERED',
  AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_2FA_ENABLED: 'AUTH_2FA_ENABLED',
  AUTH_2FA_DISABLED: 'AUTH_2FA_DISABLED',
  AUTH_2FA_CHALLENGE_FAILED: 'AUTH_2FA_CHALLENGE_FAILED',
  AUTH_TOKEN_REFRESHED: 'AUTH_TOKEN_REFRESHED',
  AUTH_PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',
  AUTH_PASSWORD_CHANGE_FAILED: 'AUTH_PASSWORD_CHANGE_FAILED',

  // kyc
  KYC_SUBMITTED: 'KYC_SUBMITTED',
  KYC_RESUBMITTED: 'KYC_RESUBMITTED',
  KYC_REVIEW_STARTED: 'KYC_REVIEW_STARTED',
  KYC_APPROVED: 'KYC_APPROVED',
  KYC_REJECTED: 'KYC_REJECTED',
  KYC_ADDITIONAL_INFO_REQUESTED: 'KYC_ADDITIONAL_INFO_REQUESTED',
  KYC_DOCUMENT_VIEWED: 'KYC_DOCUMENT_VIEWED',

  // payments in
  DEPOSIT_CREATED: 'DEPOSIT_CREATED',
  DEPOSIT_IPN_RECEIVED: 'DEPOSIT_IPN_RECEIVED',
  DEPOSIT_IPN_REJECTED: 'DEPOSIT_IPN_REJECTED',
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
  /**
   * A deposit CREDITED BY AN OPERATOR, not by a payment provider.
   *
   * Its own action on purpose: the money is real in the ledger, but no chain
   * payment happened, and an audit trail that files it under DEPOSIT_CONFIRMED
   * would claim a settlement the platform never received.
   */
  ADMIN_DEPOSIT_CREDITED: 'ADMIN_DEPOSIT_CREDITED',
  DEPOSIT_FAILED: 'DEPOSIT_FAILED',

  // payments out
  WITHDRAWAL_REQUESTED: 'WITHDRAWAL_REQUESTED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  WITHDRAWAL_BROADCAST: 'WITHDRAWAL_BROADCAST',
  WITHDRAWAL_FAILED: 'WITHDRAWAL_FAILED',

  // investments
  INVESTMENT_CREATED: 'INVESTMENT_CREATED',
  /**
   * An OPERATOR deployed a client's funds into a plan on their behalf.
   *
   * Its own action because the client did not click anything: the audit row must
   * name the operator, their stated reason, and the client's KYC status at the
   * moment of the decision — otherwise the trail implies a client action that
   * never happened, and hides that an unverified account was funded.
   */
  ADMIN_INVESTMENT_CREATED: 'ADMIN_INVESTMENT_CREATED',
  INVESTMENT_ACTIVATED: 'INVESTMENT_ACTIVATED',
  INVESTMENT_PAUSED: 'INVESTMENT_PAUSED',
  INVESTMENT_CLOSED: 'INVESTMENT_CLOSED',
  INVESTMENT_MATURED: 'INVESTMENT_MATURED',

  // broker
  BROKER_CONNECTED: 'BROKER_CONNECTED',
  BROKER_DISCONNECTED: 'BROKER_DISCONNECTED',
  BROKER_ERROR: 'BROKER_ERROR',
  BROKER_ADDED: 'BROKER_ADDED',
  BROKER_ORDER_SUBMITTED: 'BROKER_ORDER_SUBMITTED',
  BROKER_ORDER_FILLED: 'BROKER_ORDER_FILLED',
  BROKER_ORDER_REJECTED: 'BROKER_ORDER_REJECTED',
  BROKER_POSITION_CLOSED: 'BROKER_POSITION_CLOSED',

  // risk / bot
  RISK_CHECK_PASSED: 'RISK_CHECK_PASSED',
  RISK_CHECK_FAILED: 'RISK_CHECK_FAILED',
  RISK_DRAWDOWN_BREACH: 'RISK_DRAWDOWN_BREACH',
  RISK_KILL_SWITCH: 'RISK_KILL_SWITCH',
  BOT_SIGNAL_TRIGGERED: 'BOT_SIGNAL_TRIGGERED',
  BOT_STARTED: 'BOT_STARTED',
  BOT_STOPPED: 'BOT_STOPPED',
  LOT_ALLOCATED: 'LOT_ALLOCATED',
  /**
   * One per investment on every stake-sized signal, including the skipped ones.
   * Separate from LOT_ALLOCATED because the numbers mean different things: a
   * stake is money at risk, a lot is a size, and an audit trail that blurs them
   * cannot answer "how much was put at risk".
   */
  STAKE_ALLOCATED: 'STAKE_ALLOCATED',

  // admin
  PLAN_CREATED: 'PLAN_CREATED',
  PLAN_UPDATED: 'PLAN_UPDATED',
  PLAN_DEACTIVATED: 'PLAN_DEACTIVATED',
  ADMIN_USER_ROLE_CHANGED: 'ADMIN_USER_ROLE_CHANGED',
  ADMIN_SETTINGS_UPDATED: 'ADMIN_SETTINGS_UPDATED',
  ADMIN_TRADE_FORCE_CLOSED: 'ADMIN_TRADE_FORCE_CLOSED',
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

/**
 * Payout-reconciliation audit actions.
 *
 * DELIBERATELY OUTSIDE `AUDIT`. The client activity feed maps every `AuditAction`
 * exhaustively to a human message (see ACTIVITY_TEMPLATES in
 * src/server/modules/account/account.service.ts), and these are OPERATOR/
 * EVIDENCE events — a second-approval hold, a broadcast refused before any
 * provider call, a payout IPN reconciled (or not) — not client money events.
 * `AuditEntry.action` accepts a plain string, so they persist normally and the
 * feed falls back to the raw action string (its documented behaviour for an
 * action the map does not know), without a change to the account module or a
 * misleading "deposit" label on a payout row.
 *
 * Settlement itself still writes the client-visible AUDIT.WITHDRAWAL_BROADCAST
 * (and a failed payout writes AUDIT.WITHDRAWAL_FAILED), so the client feed is
 * unaffected.
 */
export const AUDIT_PAYOUT = {
  /** A payout IPN was received, matched (or not) and applied. */
  WITHDRAWAL_PAYOUT_IPN: 'WITHDRAWAL_PAYOUT_IPN',
  /** Approved by one admin and now awaiting a SECOND, different admin. */
  WITHDRAWAL_SECOND_APPROVAL_REQUIRED: 'WITHDRAWAL_SECOND_APPROVAL_REQUIRED',
  /** Broadcast refused before any provider call (conversion guard, allow-list). */
  WITHDRAWAL_PAYOUT_REFUSED: 'WITHDRAWAL_PAYOUT_REFUSED',
  /** A signature-valid IPN whose shape matched neither a deposit nor a payout. */
  IPN_UNRECOGNISED: 'IPN_UNRECOGNISED',
  /**
   * The durable replay guard had to be resolved without Redis.
   *
   * A Redis outage used to make the guard fail closed and silently drop a
   * signed deposit callback. It now falls through to Postgres, and this row is
   * the operator's signal that Redis was degraded while a money callback was
   * still processed correctly.
   */
  IPN_REPLAY_GUARD_DEGRADED: 'IPN_REPLAY_GUARD_DEGRADED',
  /**
   * An AUTOMATED payout was refused because the account could not cover it.
   *
   * Raised before any provider call, so nothing left the treasury. The client's
   * equity is unchanged and the withdrawal stays approved, awaiting an operator.
   */
  WITHDRAWAL_SETTLEMENT_BLOCKED: 'WITHDRAWAL_SETTLEMENT_BLOCKED',
  /**
   * A settlement was recorded for an account that no longer covers it.
   *
   * This is an EVIDENCE-only alert: the provider (or an operator) has already
   * moved the money, so the ledger must record reality and cannot refuse. It
   * exists so an uncovered payout is loud instead of a quiet negative equity.
   */
  WITHDRAWAL_SETTLEMENT_UNCOVERED: 'WITHDRAWAL_SETTLEMENT_UNCOVERED',
  /**
   * The trade-signal idempotency guard had to be resolved without Redis.
   *
   * The durable claim in Postgres is what stops a Redis flush from re-placing a
   * live broker order; this row records that the degraded path was used.
   */
  SIGNAL_CLAIM_DEGRADED: 'SIGNAL_CLAIM_DEGRADED',
} as const;

/**
 * Broker-reconciliation audit actions.
 *
 * DELIBERATELY OUTSIDE `AUDIT` for the same reason as `AUDIT_PAYOUT` above: the
 * client activity feed maps every `AuditAction` exhaustively to a human message
 * (ACTIVITY_TEMPLATES in src/server/modules/account/account.service.ts), and a
 * broker-versus-ledger DRIFT is an OPERATOR/EVIDENCE event — it is not a client
 * money event and it must not surface in a client's feed. `AuditEntry.action`
 * accepts a plain string, so it persists normally and the feed falls back to the
 * raw action string (its documented behaviour for an unmapped action) without a
 * change to the account module.
 *
 * The operator-facing signal for a breach is the admin activity published
 * alongside it (`publishActivity`/`makeActivity` in broker.reconcile.ts).
 */
export const AUDIT_BROKER = {
  /** The broker's own equity and the ledger's deployed equity disagree beyond the configured threshold. */
  BROKER_RECONCILIATION_DRIFT: 'BROKER_RECONCILIATION_DRIFT',
} as const;

export interface AuditEntry {
  action: AuditAction | string;
  userId?: string | null;
  details?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      userId: entry.userId ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}

/** Non-throwing variant for paths where audit failure must not abort the flow. */
export async function recordAuditSafe(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch (err) {
    console.error('[audit] failed to persist entry', entry.action, err);
  }
}

/** Read side — used by the admin Logs screen. */
export async function listAudit(opts: {
  userId?: string;
  action?: string;
  take?: number;
  cursor?: string;
}) {
  return prisma.auditLog.findMany({
    where: {
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.take ?? 50, 200),
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, email: true, fullName: true } } },
  });
}
