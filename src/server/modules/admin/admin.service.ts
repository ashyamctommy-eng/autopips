import type { BrokerConnection, KycStatus, Role, TradingPlan } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { D, formatUsd, toPrismaDecimal, usd } from '@/lib/money';
import { TARGET_RETURN_LABEL } from '@/lib/contracts';
import type {
  ActivityEventDTO,
  AumSummary,
  BrokerConnectionDTO,
  PaymentStatusValue,
  StrategyStats,
  TradingPlanDTO,
} from '@/types/api';
import {
  buildEquityFromAggregates,
  CREDITED_PAYMENT_STATUSES,
  DEBITED_PAYMENT_STATUSES,
  DEPLOYED_INVESTMENT_STATUSES,
  getOpenExposure,
  getPlatformLedger,
  getRealizedPnlToday,
} from '@/server/accounting/ledger';
import { getPlatformTradingStats, getStrategyStats } from '@/server/accounting/strategy-stats';
import { AUDIT, listAudit, recordAudit } from '@/server/modules/audit/audit.service';
import { getBotControlState } from '@/server/modules/bot/bot-control.service';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  listBrokerConnections,
  updateBrokerSnapshot,
} from '@/server/modules/broker/broker.registry';
import {
  applyPositionClosure,
  supportsPositionClosure,
  syncBrokerConnection,
  type SyncSummary,
} from '@/server/modules/broker/broker.sync';
import { planInputSchema, planUpdateSchema, type PlanInput, type PlanUpdateInput } from './plan-validation';

/**
 * ADMIN CONTROL SUITE — server service.
 *
 * Rules this file lives by:
 *  - It does NOT re-implement accounting. AUM and per-user equity come from
 *    `server/accounting/**` (`getPlatformLedger`, `getRealizedPnlToday`,
 *    `getOpenExposure`, `computeEquity`). There is exactly one equity formula in
 *    this codebase and it is not here.
 *  - It does NOT fabricate. A broker latency is `null` unless a real
 *    `adapter.ping()` round-trip produced a number; a plan's live stats are
 *    `null` when there is no closed-trade history.
 *  - Every state transition that touches money, identity, roles or the broker is
 *    written to the append-only AuditLog.
 *  - No secret (broker API token, password hash, 2FA secret, KYC object key) is
 *    ever returned or written to the audit details.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** Prisma `Role` members, as a runtime-checkable tuple for zod. */
export const ADMIN_USER_ROLES = ['CLIENT', 'ADMIN', 'TRADING_MANAGER'] as const satisfies readonly Role[];

/** Prisma `KycStatus` members — mirrors prisma/schema.prisma. */
export const KYC_STATUS_VALUES = [
  'NOT_SUBMITTED',
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'ADDITIONAL_INFO_REQUIRED',
] as const satisfies readonly KycStatus[];

/**
 * KycStatus values counted as "waiting on a human". A queue item is only
 * pending while it is actually in the reviewer's inbox — APPROVED / REJECTED /
 * ADDITIONAL_INFO_REQUIRED are all resolved from our side.
 */
export const PENDING_KYC_STATUSES = ['PENDING', 'UNDER_REVIEW'] as const satisfies readonly KycStatus[];

/** Prisma `PaymentStatus` members (types/api.ts shape, used by withdrawal lists). */
export const PAYMENT_STATUS_VALUES = [
  'PENDING',
  'WAITING',
  'CONFIRMED',
  'SENDING',
  'FINISHED',
  'FAILED',
  'REFUNDED',
] as const satisfies readonly PaymentStatusValue[];

const DEFAULT_USER_PAGE = 25;
const MAX_USER_PAGE = 100;
const MAX_ACTIVITY_TAKE = 200;

/* -------------------------------------------------------------------------- */
/* AUM / platform ledger                                                       */
/* -------------------------------------------------------------------------- */

/** Users waiting on manual KYC review. */
async function countPendingKyc(): Promise<number> {
  return prisma.user.count({ where: { kycStatus: { in: [...PENDING_KYC_STATUSES] } } });
}

/**
 * The admin landing-screen AUM card.
 *
 * Every figure is delegated:
 *   totalManagedCapital / totalEquity / activeClients / openInvestments /
 *   platformBreakdown  ← getPlatformLedger()
 *   netTodayPnL        ← getRealizedPnlToday()
 *   openMarketExposure / openPositions ← getOpenExposure() (notional, USD)
 *   pendingKycCount    ← a count over User.kycStatus
 *
 * Nothing is summed here; this function is a projection, not a second ledger.
 */
export async function getAumSummary(): Promise<AumSummary> {
  const [ledger, realizedToday, exposure, pendingKycCount] = await Promise.all([
    getPlatformLedger(),
    getRealizedPnlToday(),
    getOpenExposure(),
    countPendingKyc(),
  ]);

  return {
    totalManagedCapital: usd(ledger.totalManagedCapital).toNumber(),
    totalEquity: usd(ledger.totalEquity).toNumber(),
    openMarketExposure: usd(exposure.notional).toNumber(),
    openPositions: exposure.positions,
    netTodayPnL: usd(realizedToday).toNumber(),
    pendingKycCount,
    activeClients: ledger.activeClients,
    openInvestments: ledger.openInvestments,
    platformBreakdown: {
      realizedPnL: usd(ledger.realizedPnL).toNumber(),
      unrealizedPnL: usd(ledger.unrealizedPnL).toNumber(),
      deductedFees: usd(ledger.deductedFees).toNumber(),
      withdrawalsPaid: usd(ledger.withdrawalsPaid).toNumber(),
      confirmedDeposits: usd(ledger.confirmedDeposits).toNumber(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  country: string;
  role: Role;
  kycStatus: KycStatus;
  is2FAEnabled: boolean;
  createdAt: string;
  /** Σ Investment.capitalUsd for this user. */
  capitalUsd: number;
  /** The user's own equity, computed with the one canonical formula. */
  equity: number;
}

/** The user columns the admin list needs — nothing sensitive is selected. */
type AdminUserSelect = {
  id: string;
  email: string;
  fullName: string;
  country: string;
  role: Role;
  kycStatus: KycStatus;
  is2FAEnabled: boolean;
  createdAt: Date;
};

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  country: true,
  role: true,
  kycStatus: true,
  is2FAEnabled: true,
  createdAt: true,
} as const;

/** Equity of a user with no ledger rows at all: the formula applied to zeros. */
function zeroLedger(): { capitalUsd: number; equity: number } {
  const { equity } = buildEquityFromAggregates({
    creditedDeposits: 0,
    paidWithdrawals: 0,
    deployedCapital: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    deductedFees: 0,
  });
  return { capitalUsd: 0, equity: usd(equity).toNumber() };
}

/**
 * Per-user capital + equity for a SET of users, in a fixed number of queries.
 *
 * This is the whole point of the function: a naive admin list would run the
 * equity aggregate once per row (N+1). Instead:
 *
 *   1. `investment.groupBy(['userId'])`          — capital / unrealized / fees
 *   2. `investment.findMany({id, userId})`       — investment → user mapping
 *   3. `tradeRecord.groupBy(['investmentId'])`   — realised P/L (CLOSED only)
 *   4. `withdrawal.groupBy(['userId'])`          — paid out
 *   5. `deposit.groupBy(['userId'])`             — credited in
 *
 * => five statements per PAGE, independent of page size. Queries 2 and 3 are
 * two steps because Prisma's `groupBy` cannot group by a relation field
 * (`TradeRecord` has no `userId`), and a raw query is not needed for that.
 *
 * The arithmetic is `buildEquityFromAggregates()` from
 * `server/accounting/ledger.ts` — the single implementation of the formula — so
 * a user's admin-row equity and their own `/account/overview` equity cannot
 * drift apart. An earlier version of this function assembled the inputs itself
 * and reported a different equity than the client saw.
 */
async function aggregateUserLedgers(
  userIds: string[],
): Promise<Map<string, { capitalUsd: number; equity: number }>> {
  const result = new Map<string, { capitalUsd: number; equity: number }>();
  if (userIds.length === 0) return result;

  const [portfolioTotals, deployedTotals, investmentRows, withdrawalTotals, depositTotals] =
    await Promise.all([
      // unrealized P/L + fees live on every non-cancelled investment
      prisma.investment.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { not: 'CANCELLED' } },
        _sum: { unrealizedPnL: true, feesDeducted: true },
      }),
      // DEPLOYED capital only — the ledger's `startingCapital` term
      prisma.investment.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: [...DEPLOYED_INVESTMENT_STATUSES] } },
        _sum: { capitalUsd: true },
      }),
      prisma.investment.findMany({
        where: { userId: { in: userIds } },
        select: { id: true, userId: true },
      }),
      prisma.withdrawal.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: [...DEBITED_PAYMENT_STATUSES] } },
        _sum: { amountUsd: true },
      }),
      prisma.deposit.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: [...CREDITED_PAYMENT_STATUSES] } },
        _sum: { amountUsd: true },
      }),
    ]);

  const ownerByInvestment = new Map(investmentRows.map((row) => [row.id, row.userId]));
  const investmentIds = investmentRows.map((row) => row.id);

  const tradeTotals = investmentIds.length
    ? await prisma.tradeRecord.groupBy({
        by: ['investmentId'],
        where: { investmentId: { in: investmentIds }, status: 'CLOSED' },
        _sum: { netPnL: true },
      })
    : [];

  const realizedByUser = new Map<string, ReturnType<typeof D>>();
  for (const trade of tradeTotals) {
    const userId = ownerByInvestment.get(trade.investmentId);
    if (!userId) continue;
    realizedByUser.set(userId, D(realizedByUser.get(userId) ?? 0).plus(D(trade._sum.netPnL)));
  }

  const portfolioByUser = new Map(portfolioTotals.map((row) => [row.userId, row]));
  const deployedByUser = new Map(deployedTotals.map((row) => [row.userId, row]));
  const withdrawalsByUser = new Map(
    withdrawalTotals.map((row) => [row.userId, D(row._sum.amountUsd)]),
  );
  const depositsByUser = new Map(
    depositTotals.map((row) => [row.userId, D(row._sum.amountUsd)]),
  );

  for (const userId of userIds) {
    const portfolio = portfolioByUser.get(userId);
    const deployed = D(deployedByUser.get(userId)?._sum.capitalUsd);

    // Same single formula implementation as the client-facing ledger.
    const { equity } = buildEquityFromAggregates({
      creditedDeposits: depositsByUser.get(userId) ?? 0,
      paidWithdrawals: withdrawalsByUser.get(userId) ?? 0,
      deployedCapital: deployed,
      realizedPnL: realizedByUser.get(userId) ?? 0,
      unrealizedPnL: D(portfolio?._sum.unrealizedPnL),
      deductedFees: D(portfolio?._sum.feesDeducted),
    });

    result.set(userId, { capitalUsd: usd(deployed).toNumber(), equity: usd(equity).toNumber() });
  }

  return result;
}

function toAdminUserRow(
  user: AdminUserSelect,
  ledger: { capitalUsd: number; equity: number } | undefined,
): AdminUserRow {
  const totals = ledger ?? zeroLedger();
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    country: user.country,
    role: user.role,
    kycStatus: user.kycStatus,
    is2FAEnabled: user.is2FAEnabled,
    createdAt: user.createdAt.toISOString(),
    capitalUsd: totals.capitalUsd,
    equity: totals.equity,
  };
}

export interface AdminUserQuery {
  search?: string;
  role?: Role;
  kycStatus?: KycStatus;
  take?: number;
  cursor?: string;
}

/** Cursor-paginated admin user list (newest first). */
export async function listUsers(
  query: AdminUserQuery = {},
): Promise<{ items: AdminUserRow[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(1, Math.trunc(query.take ?? DEFAULT_USER_PAGE)), MAX_USER_PAGE);
  const search = query.search?.trim();

  const rows = await prisma.user.findMany({
    where: {
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { fullName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.kycStatus ? { kycStatus: query.kycStatus } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: ADMIN_USER_SELECT,
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  // One batch aggregate for the whole page — never one query per user.
  const ledgers = await aggregateUserLedgers(page.map((row) => row.id));

  return {
    items: page.map((row) => toAdminUserRow(row, ledgers.get(row.id))),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** One admin user row (same shape as a list row). */
export async function getAdminUser(id: string): Promise<AdminUserRow> {
  const user = await prisma.user.findUnique({ where: { id }, select: ADMIN_USER_SELECT });
  if (!user) throw ApiError.notFound('User not found.');
  const ledgers = await aggregateUserLedgers([user.id]);
  return toAdminUserRow(user, ledgers.get(user.id));
}

export interface UpdateUserRoleInput {
  adminUserId: string;
  targetUserId: string;
  role: Role;
  ip?: string | null;
}

export interface UserMutationResult {
  user: AdminUserRow;
  changedFields: string[];
}

/**
 * Change a user's platform role.
 *
 * LAST-ADMIN PROTECTION (the platform must never lock itself out):
 * demoting an ADMIN is refused when it would leave zero admins — the admin
 * count is read BEFORE the update and the caller gets a 409 explaining exactly
 * why. Without this, the only remaining administrator could demote themselves
 * and no human would be able to approve KYC, settle withdrawals, add a broker
 * or promote anyone back.
 *
 * The count and the update run in ONE transaction and the admin count is
 * re-checked after the write: if two admins demote themselves concurrently, both
 * transactions see zero admins left and both roll back, so the platform cannot be
 * locked out by a race either.
 *
 * Audit: ADMIN_USER_ROLE_CHANGED, with previous + new role and the admin count
 * observed during the check.
 */
export async function updateUserRole(input: UpdateUserRoleInput): Promise<UserMutationResult> {
  const { adminUserId, targetUserId, role, ip } = input;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true, role: true },
  });
  if (!target) throw ApiError.notFound('User not found.');

  if (target.role === role) {
    throw ApiError.conflict(`This user already has the ${role} role; nothing to change.`);
  }

  const demotesAdmin = target.role === 'ADMIN' && role !== 'ADMIN';
  const adminCount = demotesAdmin
    ? await prisma.user.count({ where: { role: 'ADMIN' } })
    : null;

  if (demotesAdmin && (adminCount ?? 0) <= 1) {
    throw ApiError.conflict(
      'Refusing to demote the last remaining ADMIN: no administrator would be left to approve KYC, ' +
        'settle withdrawals or manage brokers, and the platform could not be recovered from inside the app. ' +
        'Promote another user to ADMIN first.',
    );
  }

  await prisma.$transaction(async (tx) => {
    if (demotesAdmin) {
      const adminsNow = await tx.user.count({ where: { role: 'ADMIN' } });
      if (adminsNow <= 1) {
        throw ApiError.conflict(
          'Refusing to demote the last remaining ADMIN: another change left this user as the only administrator.',
        );
      }
    }
    await tx.user.update({ where: { id: target.id }, data: { role } });
    if (demotesAdmin) {
      const adminsAfter = await tx.user.count({ where: { role: 'ADMIN' } });
      if (adminsAfter === 0) {
        // Roll back rather than persist an unrecoverable state.
        throw ApiError.conflict(
          'Refusing to demote the last remaining ADMIN: this change would leave the platform with no administrator.',
        );
      }
    }
  });

  await recordAudit({
    action: AUDIT.ADMIN_USER_ROLE_CHANGED,
    userId: adminUserId,
    ipAddress: ip ?? null,
    details: {
      targetUserId: target.id,
      targetEmail: target.email,
      previousRole: target.role,
      newRole: role,
      adminsBeforeChange: adminCount,
      // The role in an already-issued access token only changes when that token
      // is refreshed / re-issued (ACCESS_TOKEN_TTL), it is not re-signed here.
      note: 'Effective at the target user’s next token refresh.',
    },
  });

  return { user: await getAdminUser(target.id), changedFields: ['role'] };
}

export interface UpdateUserProfileInput {
  adminUserId: string;
  targetUserId: string;
  fullName?: string;
  country?: string;
  phone?: string | null;
  ip?: string | null;
}

/**
 * Update the non-sensitive profile fields of a user.
 *
 * Deliberately limited to `fullName`, `country` and `phone`. Identity and
 * credential columns are NOT writable through the admin API:
 *   - `email`             — the login identifier and KYC anchor; changing it
 *                           requires a verification flow, not an admin edit.
 *   - `kycStatus`         — only the KYC decision endpoint may move it.
 *   - `passwordHash`      — a credential; never settable by an admin.
 *   - `twoFactorSecret`   — a second factor is only ever enrolled by its owner.
 * (`admin.users` route rejects these keys explicitly before calling this.)
 */
export async function updateUserProfile(input: UpdateUserProfileInput): Promise<UserMutationResult> {
  const { adminUserId, targetUserId, fullName, country, phone, ip } = input;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true, fullName: true, country: true, phone: true },
  });
  if (!target) throw ApiError.notFound('User not found.');

  const data: Prisma.UserUpdateInput = {};
  const changed: string[] = [];
  const previous: Record<string, string | null> = {};
  const next: Record<string, string | null> = {};

  if (fullName !== undefined && fullName !== target.fullName) {
    data.fullName = fullName;
    previous.fullName = target.fullName;
    next.fullName = fullName;
    changed.push('fullName');
  }
  if (country !== undefined && country !== target.country) {
    data.country = country;
    previous.country = target.country;
    next.country = country;
    changed.push('country');
  }
  if (phone !== undefined && (phone ?? null) !== target.phone) {
    data.phone = phone ?? null;
    previous.phone = target.phone;
    next.phone = phone ?? null;
    changed.push('phone');
  }

  if (changed.length === 0) {
    // Nothing to apply: not an error, and deliberately not an audit entry —
    // the log records changes, not requests.
    return { user: await getAdminUser(target.id), changedFields: [] };
  }

  await prisma.user.update({ where: { id: target.id }, data });

  await recordAudit({
    // The platform's defined action for an admin-side settings change. The
    // affected user and the exact field names live in the details.
    action: AUDIT.ADMIN_SETTINGS_UPDATED,
    userId: adminUserId,
    ipAddress: ip ?? null,
    details: {
      targetUserId: target.id,
      targetEmail: target.email,
      scope: 'USER_PROFILE',
      changedFields: changed,
      previous,
      // Values ARE included for these three fields only (they are public profile
      // data, not secrets) so the trail is meaningful.
      next,
    },
  });

  return { user: await getAdminUser(target.id), changedFields: changed };
}

/* -------------------------------------------------------------------------- */
/* Trading plans                                                               */
/* -------------------------------------------------------------------------- */

function toPlanDTO(row: TradingPlan, stats: StrategyStats | null): TradingPlanDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    minInvestment: usd(row.minInvestment).toNumber(),
    maxInvestment: usd(row.maxInvestment).toNumber(),
    durationDays: row.durationDays,
    targetReturnMin: D(row.targetReturnMin).toNumber(),
    targetReturnMax: D(row.targetReturnMax).toNumber(),
    riskLevel: row.riskLevel,
    performanceFee: D(row.performanceFee).toNumber(),
    managementFee: D(row.managementFee).toNumber(),
    maxDrawdown: D(row.maxDrawdown).toNumber(),
    isActive: row.isActive,
    targetReturnLabel: TARGET_RETURN_LABEL,
    stats,
  };
}

/** Stored plan → the validated create input shape (used to merge PATCHes). */
function rowToPlanInput(row: TradingPlan): PlanInput {
  return {
    name: row.name,
    description: row.description,
    minInvestment: usd(row.minInvestment).toNumber(),
    maxInvestment: usd(row.maxInvestment).toNumber(),
    durationDays: row.durationDays,
    targetReturnMin: D(row.targetReturnMin).toNumber(),
    targetReturnMax: D(row.targetReturnMax).toNumber(),
    riskLevel: row.riskLevel as PlanInput['riskLevel'],
    performanceFee: D(row.performanceFee).toNumber(),
    managementFee: D(row.managementFee).toNumber(),
    maxDrawdown: D(row.maxDrawdown).toNumber(),
    isActive: row.isActive,
  };
}

function planDataFor(input: PlanInput) {
  return {
    name: input.name,
    description: input.description,
    minInvestment: toPrismaDecimal(input.minInvestment),
    maxInvestment: toPrismaDecimal(input.maxInvestment),
    durationDays: input.durationDays,
    targetReturnMin: toPrismaDecimal(input.targetReturnMin),
    targetReturnMax: toPrismaDecimal(input.targetReturnMax),
    riskLevel: input.riskLevel,
    performanceFee: toPrismaDecimal(input.performanceFee),
    managementFee: toPrismaDecimal(input.managementFee),
    maxDrawdown: toPrismaDecimal(input.maxDrawdown),
    isActive: input.isActive,
  };
}

/**
 * Every plan, with its live strategy stats.
 *
 * `stats` comes from `getStrategyStats()` (15s cache) and is `null` when the
 * plan has no closed trades — the honest "no verified track record" answer, not
 * a zeroed-out placeholder. Pass `{ includeStats: false }` for a listing where
 * the stat cards are not shown; `stats` is then null for every row, which means
 * "not computed for this request".
 */
export async function listPlans(
  options: { includeStats?: boolean } = {},
): Promise<TradingPlanDTO[]> {
  const rows = await prisma.tradingPlan.findMany({ orderBy: { createdAt: 'desc' } });
  if (options.includeStats === false || rows.length === 0) {
    return rows.map((row) => toPlanDTO(row, null));
  }
  const stats = await Promise.all(rows.map((row) => getStrategyStats(row.id)));
  return rows.map((row, index) => toPlanDTO(row, stats[index] ?? null));
}

/** One plan with its live stats, or a 404. */
export async function getPlan(id: string): Promise<TradingPlanDTO> {
  const row = await prisma.tradingPlan.findUnique({ where: { id } });
  if (!row) throw ApiError.notFound('Trading plan not found.');
  return toPlanDTO(row, await getStrategyStats(row.id));
}

/**
 * Create a trading plan. Input is validated here (not only in the route) so the
 * contract cannot be bypassed by another server-side caller.
 *
 * Audit: PLAN_CREATED with the full created configuration.
 */
export async function createPlan(
  input: unknown,
  adminUserId: string,
  ip?: string | null,
): Promise<TradingPlanDTO> {
  const data = planInputSchema.parse(input);
  const created = await prisma.tradingPlan.create({ data: planDataFor(data) });

  await recordAudit({
    action: AUDIT.PLAN_CREATED,
    userId: adminUserId,
    ipAddress: ip ?? null,
    details: {
      planId: created.id,
      name: created.name,
      minInvestment: data.minInvestment,
      maxInvestment: data.maxInvestment,
      durationDays: data.durationDays,
      targetReturnMin: data.targetReturnMin,
      targetReturnMax: data.targetReturnMax,
      riskLevel: data.riskLevel,
      performanceFee: data.performanceFee,
      managementFee: data.managementFee,
      maxDrawdown: data.maxDrawdown,
      isActive: data.isActive,
    },
  });

  // A brand-new plan has no closed trades by definition: stats are null.
  return toPlanDTO(created, null);
}

/**
 * Update a trading plan.
 *
 * The patch is applied onto the stored plan and the RESULT is re-validated, so
 * cross-field rules hold for the plan that will actually exist (e.g. lowering
 * `maxInvestment` below the stored `minInvestment` is rejected).
 *
 * GRANDFATHERING: raising `minInvestment` above the capital of investments that
 * are already running is ALLOWED — existing clients keep their terms — but the
 * number of affected investments is recorded in the audit details so the change
 * is reviewable.
 *
 * Audit: PLAN_DEACTIVATED when the plan is switched off, PLAN_UPDATED otherwise.
 */
export async function updatePlan(
  id: string,
  input: unknown,
  adminUserId: string,
  ip?: string | null,
): Promise<TradingPlanDTO> {
  const current = await prisma.tradingPlan.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('Trading plan not found.');

  const patch: PlanUpdateInput = planUpdateSchema.parse(input);
  // Drop explicit `undefined`s so the stored plan's values are what remain when a
  // field is absent from the patch.
  const definedPatch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) definedPatch[field] = value;
  }

  const merged: PlanInput = planInputSchema.parse({
    ...rowToPlanInput(current),
    ...definedPatch,
  });

  const previousInput = rowToPlanInput(current);
  const changedFields = (Object.keys(merged) as (keyof PlanInput)[]).filter(
    (field) => merged[field] !== previousInput[field],
  );

  // Which investments are now below the plan's minimum? Only recomputed when the
  // minimum actually moved.
  const raisedMinimum = D(merged.minInvestment).greaterThan(D(current.minInvestment));
  const grandfatheredInvestments = raisedMinimum
    ? await prisma.investment.count({
        where: { planId: id, capitalUsd: { lt: toPrismaDecimal(merged.minInvestment) } },
      })
    : 0;

  const updated = await prisma.tradingPlan.update({ where: { id }, data: planDataFor(merged) });

  const deactivated = current.isActive && !merged.isActive;

  await recordAudit({
    action: deactivated ? AUDIT.PLAN_DEACTIVATED : AUDIT.PLAN_UPDATED,
    userId: adminUserId,
    ipAddress: ip ?? null,
    details: {
      planId: updated.id,
      name: updated.name,
      changedFields,
      previous: previousInput,
      next: merged,
      isActive: merged.isActive,
      grandfatheredInvestments,
      grandfatheringNote:
        grandfatheredInvestments > 0
          ? `${grandfatheredInvestments} existing investment(s) hold capital below the new minimum of $${formatUsd(merged.minInvestment)}; their terms are grandfathered and they are not affected.`
          : null,
    },
  });

  return toPlanDTO(updated, await getStrategyStats(updated.id));
}

/* -------------------------------------------------------------------------- */
/* Brokers                                                                     */
/* -------------------------------------------------------------------------- */

function toBrokerDTO(row: BrokerConnection, latencyMs: number | null = null): BrokerConnectionDTO {
  return {
    id: row.id,
    metaApiAccountId: row.metaApiAccountId,
    brokerName: row.brokerName,
    environment: row.environment,
    maskedAccount: row.maskedAccount,
    balance: row.balance === null ? null : usd(row.balance).toNumber(),
    equity: row.equity === null ? null : usd(row.equity).toNumber(),
    freeMargin: row.freeMargin === null ? null : usd(row.freeMargin).toNumber(),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    latencyMs,
  };
}

/** One stored connection as a DTO (no live probe). */
export async function getBrokerConnection(id: string): Promise<BrokerConnectionDTO> {
  const row = await prisma.brokerConnection.findUnique({ where: { id } });
  if (!row) throw ApiError.notFound('Broker connection not found.');
  return toBrokerDTO(row);
}

/**
 * Every broker connection.
 *
 * `latencyMs` is a REAL RPC round-trip (`BrokerAdapter.ping()` → broker
 * `getServerTime`). Probing means connecting an adapter per account, which is
 * far too expensive to do on every page load, so it only happens when the caller
 * asks for it (`?probe=1`). Otherwise `latencyMs` is `null` — meaning "not
 * probed in this request", never a made-up number. A probe that fails or times
 * out also yields `null` rather than a guess.
 */
export async function listBrokers(
  options: { probeLatency?: boolean } = {},
): Promise<BrokerConnectionDTO[]> {
  const rows = await listBrokerConnections();
  if (!options.probeLatency || rows.length === 0) {
    return rows.map((row) => toBrokerDTO(row));
  }

  const latencies = await Promise.all(
    rows.map(async (row): Promise<number | null> => {
      try {
        const adapter = await ensureBrokerConnected(await getAdapterForConnection(row));
        return await adapter.ping();
      } catch (err) {
        console.error(
          `[admin] latency probe failed for broker connection ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );

  return rows.map((row, index) => toBrokerDTO(row, latencies[index] ?? null));
}

export interface BrokerLatencyProbe {
  id: string;
  /** Real RPC round-trip in ms; null when the probe could not complete. */
  latencyMs: number | null;
  status: string;
}

/**
 * Probe one connection and refresh its stored snapshot.
 *
 * - `latencyMs` is measured by `adapter.ping()` (a real `getServerTime` RPC).
 * - The account state is then read from the bridge and persisted through
 *   `updateBrokerSnapshot()`, so the row's balance / equity / freeMargin /
 *   status always reflect the last broker-reported values.
 * - If the state read fails, the previously stored status is returned: it is the
 *   last value the broker actually reported, not an invented one.
 */
export async function probeBrokerLatency(id: string): Promise<BrokerLatencyProbe> {
  const conn = await prisma.brokerConnection.findUnique({ where: { id } });
  if (!conn) throw ApiError.notFound('Broker connection not found.');

  const adapter = await ensureBrokerConnected(await getAdapterForConnection(conn));
  const latencyMs = await adapter.ping();

  let status = conn.status;
  try {
    const state = await adapter.getAccountState();
    await updateBrokerSnapshot(conn.id, state);
    status = state.status;
  } catch (err) {
    console.error(
      `[admin] account state read failed for broker connection ${conn.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { id: conn.id, latencyMs, status };
}

/** Force one synchronization cycle for a single connection. */
export async function syncBrokerById(
  id: string,
): Promise<{ connectionId: string; summary: SyncSummary }> {
  const conn = await prisma.brokerConnection.findUnique({ where: { id } });
  if (!conn) throw ApiError.notFound('Broker connection not found.');
  const summary = await syncBrokerConnection(conn);
  return { connectionId: conn.id, summary };
}

/* -------------------------------------------------------------------------- */
/* Activity feed                                                               */
/* -------------------------------------------------------------------------- */

type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

const ACTIVITY_ACRONYMS = new Set([
  'KYC',
  'IPN',
  'API',
  'AUM',
  'HWM',
  '2FA',
  'DERIV',
  'TOTP',
  'PNL',
  'USD',
]);

/** `WITHDRAWAL_APPROVED` → `Withdrawal approved`. No invented wording. */
function humanizeAction(action: string): string {
  const sentence = action
    .split('_')
    .map((word) => {
      const upper = word.toUpperCase();
      return ACTIVITY_ACRONYMS.has(upper) ? upper : word.toLowerCase();
    })
    .join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Explicit overrides; everything else falls back to suffix heuristics. */
const ACTIVITY_SEVERITY = {
  success: [
    AUDIT.AUTH_2FA_ENABLED,
    AUDIT.DEPOSIT_CONFIRMED,
    AUDIT.KYC_APPROVED,
    AUDIT.WITHDRAWAL_APPROVED,
    AUDIT.WITHDRAWAL_BROADCAST,
    AUDIT.INVESTMENT_ACTIVATED,
    AUDIT.INVESTMENT_MATURED,
    AUDIT.BROKER_ORDER_FILLED,
    AUDIT.BROKER_ADDED,
    AUDIT.BROKER_CONNECTED,
    AUDIT.RISK_CHECK_PASSED,
    AUDIT.PLAN_CREATED,
  ],
  warning: [
    AUDIT.AUTH_LOGIN_FAILED,
    AUDIT.KYC_REJECTED,
    AUDIT.KYC_ADDITIONAL_INFO_REQUESTED,
    AUDIT.WITHDRAWAL_REJECTED,
    AUDIT.BROKER_DISCONNECTED,
    AUDIT.INVESTMENT_PAUSED,
  ],
  error: [
    AUDIT.RISK_KILL_SWITCH,
    AUDIT.RISK_DRAWDOWN_BREACH,
    AUDIT.RISK_CHECK_FAILED,
    AUDIT.DEPOSIT_IPN_REJECTED,
    AUDIT.AUTH_2FA_CHALLENGE_FAILED,
  ],
} as const;

function severityFor(action: string): ActivityEventDTO['severity'] {
  if ((ACTIVITY_SEVERITY.success as readonly string[]).includes(action)) return 'success';
  if ((ACTIVITY_SEVERITY.warning as readonly string[]).includes(action)) return 'warning';
  if ((ACTIVITY_SEVERITY.error as readonly string[]).includes(action)) return 'error';
  if (action.endsWith('_FAILED') || action.endsWith('_ERROR') || action.endsWith('_REJECTED')) {
    return 'error';
  }
  return 'info';
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function toActivityEvent(row: AuditRow): ActivityEventDTO {
  const details = asRecord(row.details);
  const amount = details.amountUsd;
  const amountSuffix =
    typeof amount === 'number' && Number.isFinite(amount) ? ` — $${formatUsd(amount)}` : '';

  return {
    id: row.id,
    action: row.action,
    message: `${humanizeAction(row.action)}${amountSuffix}`,
    severity: severityFor(row.action),
    details,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Platform-wide recent audit events, newest first (the admin activity feed). */
/**
 * Turn a user's bot on or off for every investment they hold.
 *
 * The platform's per-user control IS the investment status: `PAUSED` means the
 * strategy engine may not open new positions for that investment, which is
 * exactly what "disable this user's bot" means. Only ACTIVE <-> PAUSED rows are
 * touched — a MATURED/CLOSED/CANCELLED investment has already settled and is
 * never re-opened by an operator toggle.
 *
 * Returns what actually changed, so the console can say "3 paused, 1 skipped"
 * instead of claiming a blanket success.
 */
export async function setUserBotEnabled(input: {
  userId: string;
  enabled: boolean;
  actorId: string;
  ip: string | null;
}): Promise<{ changed: number; skipped: number; investmentIds: string[] }> {
  const from = input.enabled ? 'PAUSED' : 'ACTIVE';
  const to = input.enabled ? 'ACTIVE' : 'PAUSED';

  const affected = await prisma.investment.findMany({
    where: { userId: input.userId, status: from },
    select: { id: true },
  });

  const skipped = await prisma.investment.count({
    where: {
      userId: input.userId,
      status: { notIn: ['ACTIVE', 'PAUSED'] },
    },
  });

  for (const investment of affected) {
    await prisma.investment.update({
      where: { id: investment.id },
      data: { status: to },
    });
    await recordAudit({
      action: input.enabled ? AUDIT.INVESTMENT_ACTIVATED : AUDIT.INVESTMENT_PAUSED,
      userId: input.actorId,
      ipAddress: input.ip,
      details: {
        investmentId: investment.id,
        clientUserId: input.userId,
        source: 'admin_bot_toggle',
        status: to,
      },
    });
  }

  return {
    changed: affected.length,
    skipped,
    investmentIds: affected.map((investment) => investment.id),
  };
}

/**
 * Close a booked trade at the broker now.
 *
 * Sends a real close request and then settles the row through the SAME path the
 * periodic sync uses (`applyPositionClosure`), so an admin action cannot invent
 * a fill price or a P/L the broker did not report. When the sync declines to
 * settle (for example a contract-broker position with no lot size, whose
 * exposure model is still undecided), the broker close is still reported
 * honestly and the row is left for the sync rather than force-written.
 */
export async function forceCloseTrade(input: {
  tradeId: string;
  actorId: string;
  ip: string | null;
}): Promise<{
  closedAtBroker: boolean;
  settled: boolean;
  brokerMessage: string;
  netPnL: number | null;
}> {
  const trade = await prisma.tradeRecord.findUnique({
    where: { id: input.tradeId },
    select: {
      id: true,
      investmentId: true,
      brokerId: true,
      metaApiPositionId: true,
      instrument: true,
      status: true,
    },
  });
  if (!trade) throw ApiError.notFound('Trade not found.');
  if (trade.status !== 'OPEN') {
    throw ApiError.conflict(`Trade ${trade.id} is ${trade.status}; only an OPEN trade can be force-closed.`);
  }
  if (!trade.metaApiPositionId) {
    throw ApiError.conflict(
      'This trade has no broker position id, so there is nothing to close at the broker.',
    );
  }

  const connection = await prisma.brokerConnection.findUnique({ where: { id: trade.brokerId } });
  if (!connection) throw ApiError.conflict('The broker connection for this trade is gone.');

  const adapter = await ensureBrokerConnected(await getAdapterForConnection(connection));

  const result = await adapter.closePosition(trade.metaApiPositionId);

  let settled = false;
  let netPnL: number | null = null;

  if (result.ok && supportsPositionClosure(adapter)) {
    const closure = await adapter.getPositionClosure(trade.metaApiPositionId);
    if (closure) {
      const applied = await applyPositionClosure(connection.id, closure);
      settled = applied !== null;
      netPnL = applied?.netPnL ?? null;
    }
  }

  await recordAudit({
    action: result.ok ? AUDIT.ADMIN_TRADE_FORCE_CLOSED : AUDIT.BROKER_ERROR,
    userId: input.actorId,
    ipAddress: input.ip,
    details: {
      tradeId: trade.id,
      investmentId: trade.investmentId,
      instrument: trade.instrument,
      brokerPositionId: trade.metaApiPositionId,
      ok: result.ok,
      settled,
      netPnL,
      brokerMessage: result.brokerMessage ?? null,
    },
  });

  return {
    closedAtBroker: result.ok,
    settled,
    brokerMessage: result.brokerMessage ?? 'No broker message.',
    netPnL,
  };
}

/**
 * The bot-control console's read model: kill-switch state, effective limits and
 * the broker's instrument list.
 *
 * Deliberately tolerant: the broker may be unreachable, and the console still has
 * to be usable then — an operator most needs the emergency stop when the broker
 * is the thing that is broken. An unavailable instrument list is reported as
 * such (`symbolsError`) instead of looking like "the broker offers nothing".
 */
export async function getBotControlView(): Promise<{
  killSwitch: Awaited<ReturnType<typeof getBotControlState>>;
  symbols: Array<{ symbol: string; displayName: string; market: string; isTradable: boolean }>;
  symbolsError: string | null;
}> {
  const killSwitch = await getBotControlState();

  try {
    const connections = await listBrokerConnections();
    const connection = connections.find((row) => row.status === 'CONNECTED') ?? connections[0];
    if (!connection) {
      return { killSwitch, symbols: [], symbolsError: 'No broker connection is registered yet.' };
    }

    const adapter = await ensureBrokerConnected(await getAdapterForConnection(connection));
    const symbols = (await adapter.listInstruments()).map((instrument) => ({
      symbol: instrument.symbol,
      displayName: instrument.displayName,
      market: instrument.market,
      isTradable: instrument.isTradable,
    }));
    return { killSwitch, symbols, symbolsError: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The broker could not list instruments.';
    console.warn('[admin] instrument list unavailable:', message);
    return { killSwitch, symbols: [], symbolsError: message };
  }
}

export async function getAdminActivity(take = 25): Promise<ActivityEventDTO[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(take)), MAX_ACTIVITY_TAKE);
  const rows = await listAudit({ take: bounded });
  return rows.map(toActivityEvent);
}

/* -------------------------------------------------------------------------- */
/* Overview (one round trip for the admin landing screen)                      */
/* -------------------------------------------------------------------------- */

export interface AdminOverview {
  aum: AumSummary;
  /** Mirrors `aum.pendingKycCount` — surfaced so the header badge needs no extra read. */
  pendingKycCount: number;
  recentActivity: ActivityEventDTO[];
  /** Broker connections WITHOUT a latency probe (the AUM screen must be cheap). */
  brokers: BrokerConnectionDTO[];
  tradingStats: {
    closedTrades: number;
    winRatePct: number | null;
    netPnL: number;
    instruments: string[];
    activeStrategies: number;
    firstTradeAt: string | null;
    lastTradeAt: string | null;
  } | null;
}

/**
 * The combined admin dashboard payload: AUM + pending KYC + activity feed +
 * broker list (no probing) + platform trading stats. Four independent reads run
 * concurrently; each panel maps to exactly one function above.
 */
export async function getAdminOverview(): Promise<AdminOverview> {
  const [aum, recentActivity, brokers, tradingStats] = await Promise.all([
    getAumSummary(),
    getAdminActivity(25),
    listBrokers({ probeLatency: false }),
    getPlatformTradingStats(),
  ]);

  return {
    aum,
    pendingKycCount: aum.pendingKycCount,
    recentActivity,
    brokers,
    tradingStats,
  };
}
