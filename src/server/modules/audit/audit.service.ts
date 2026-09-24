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
  DEPOSIT_FAILED: 'DEPOSIT_FAILED',

  // payments out
  WITHDRAWAL_REQUESTED: 'WITHDRAWAL_REQUESTED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  WITHDRAWAL_BROADCAST: 'WITHDRAWAL_BROADCAST',
  WITHDRAWAL_FAILED: 'WITHDRAWAL_FAILED',

  // investments
  INVESTMENT_CREATED: 'INVESTMENT_CREATED',
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

  // admin
  PLAN_CREATED: 'PLAN_CREATED',
  PLAN_UPDATED: 'PLAN_UPDATED',
  PLAN_DEACTIVATED: 'PLAN_DEACTIVATED',
  ADMIN_USER_ROLE_CHANGED: 'ADMIN_USER_ROLE_CHANGED',
  ADMIN_SETTINGS_UPDATED: 'ADMIN_SETTINGS_UPDATED',
  ADMIN_TRADE_FORCE_CLOSED: 'ADMIN_TRADE_FORCE_CLOSED',
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

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
