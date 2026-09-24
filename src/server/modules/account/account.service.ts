import type { AuditAction } from '@/server/modules/audit/audit.service';
import type { Investment, Prisma, TradeRecord, TradingPlan } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { D, formatUsd, toPrismaDecimal, type Decimal } from '@/lib/money';
import { TARGET_RETURN_DISCLAIMER, TARGET_RETURN_LABEL } from '@/lib/contracts';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { EQUITY_FORMULA } from '@/server/accounting/equity';
import { getStrategyStats } from '@/server/accounting/strategy-stats';
import { AUDIT, listAudit, recordAudit } from '@/server/modules/audit/audit.service';
import type {
  AccountOverview,
  ActivityEventDTO,
  InvestmentDTO,
  PositionDTO,
  SessionUser,
  TradingPlanDTO,
} from '@/types/api';

/**
 * Client account read model + the investment entry point.
 *
 * Every balance shown to a client comes from `getAccountSnapshot()` (which is
 * the only place the equity formula is applied to persisted rows). Nothing in
 * this module recomputes money: it shapes verified ledger rows into the wire
 * DTOs and, in exactly one place — `createInvestment` — it moves capital.
 *
 * Zero-simulation rules that this file is responsible for honouring:
 *   • An unrealised figure that the broker has not reported is `null`, never a
 *     number derived from an entry price.
 *   • A strategy's track record comes from closed broker trades only; with no
 *     history the stats are `null` and the UI must say so.
 *   • Every target/indicative return travels with TARGET_RETURN_LABEL or the
 *     full disclaimer.
 *   • Activity is read back out of the append-only audit table — never invented.
 */

// ─── DTO boundaries ─────────────────────────────────────────────────────────
// Decimal → number conversion happens HERE and nowhere else: arithmetic stays in
// Decimal throughout the server, and only the JSON boundary degrades to a double.

function num(value: Decimal): number {
  return value.toNumber();
}

type InvestmentWithPlan = Investment & { plan: TradingPlan };

export interface TradeDTO {
  id: string;
  investmentId: string;
  metaApiPositionId: string | null;
  instrument: string;
  direction: string;
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  grossPnL: number;
  commission: number;
  swap: number;
  netPnL: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateInvestmentArgs {
  user: SessionUser;
  planId: string;
  amountUsd: number;
  ip: string | null;
}

// ─── overview ───────────────────────────────────────────────────────────────

/**
 * The client dashboard summary. Computed entirely from the ledger snapshot;
 * `formula` is the same constant the accounting module applies, so the UI can
 * always show the user how the number was produced.
 */
export async function getOverview(userId: string): Promise<AccountOverview> {
  const snapshot = await getAccountSnapshot(userId);
  const b = snapshot.breakdown;

  return {
    equity: num(b.equity),
    breakdown: {
      startingCapital: num(b.startingCapital),
      realizedPnL: num(b.realizedPnL),
      unrealizedPnL: num(b.unrealizedPnL),
      deductedFees: num(b.deductedFees),
      withdrawals: num(b.withdrawals),
      confirmedDeposits: num(b.confirmedDeposits),
      netContributedCapital: num(snapshot.netContributedCapital),
      totalCreditedDeposits: num(snapshot.totalCreditedDeposits),
      totalPaidWithdrawals: num(snapshot.totalPaidWithdrawals),
    },
    netProfit: num(b.netProfit),
    netReturnPct: num(b.netReturnPct),
    grossPnL: num(b.grossPnL),
    activeCapital: num(snapshot.activeCapital),
    withdrawableBalance: num(snapshot.withdrawableBalance),
    pendingWithdrawals: num(snapshot.pendingWithdrawals),
    formula: EQUITY_FORMULA,
    disclaimer: TARGET_RETURN_DISCLAIMER,
  };
}

// ─── investments ────────────────────────────────────────────────────────────

function toInvestmentDTO(investment: InvestmentWithPlan): InvestmentDTO {
  return {
    id: investment.id,
    planId: investment.planId,
    planName: investment.plan.name,
    riskLevel: investment.plan.riskLevel,
    capitalUsd: num(investment.capitalUsd),
    currentValUsd: num(investment.currentValUsd),
    realizedPnL: num(investment.realizedPnL),
    unrealizedPnL: num(investment.unrealizedPnL),
    feesDeducted: num(investment.feesDeducted),
    status: investment.status,
    startDate: investment.startDate?.toISOString() ?? null,
    maturityDate: investment.maturityDate?.toISOString() ?? null,
    targetReturnMin: num(investment.plan.targetReturnMin),
    targetReturnMax: num(investment.plan.targetReturnMax),
    createdAt: investment.createdAt.toISOString(),
  };
}

/**
 * Mirror of `requireVerifiedClient()` for callers that already hold a
 * SessionUser (services never read cookies). Staff bypass; everyone else needs
 * an APPROVED KYC record. Same rule as the payments service applies to money
 * moving out, because deploying capital moves money too.
 */
function assertVerifiedClient(user: SessionUser): void {
  if (user.role === 'ADMIN' || user.role === 'TRADING_MANAGER') return;
  if (user.kycStatus !== 'APPROVED') throw ApiError.kycRequired();
}

export async function listInvestments(userId: string): Promise<InvestmentDTO[]> {
  const investments = await prisma.investment.findMany({
    where: { userId },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
  return investments.map(toInvestmentDTO);
}

/**
 * Deploys capital into a plan.
 *
 * The only spendable money is `withdrawableBalance` from the ledger, i.e. equity
 * minus capital already deployed into ACTIVE/PAUSED investments minus
 * withdrawals already requested. Re-investing the same dollar twice is
 * therefore impossible by construction — the second attempt sees the first
 * deployment in `activeCapital` and is rejected with INSUFFICIENT_FUNDS.
 *
 * No fee is taken here: management and performance fees are booked by the fee
 * engine against realised results, which is the only point at which they can be
 * measured.
 */
export async function createInvestment(args: CreateInvestmentArgs): Promise<InvestmentDTO> {
  const { user, planId, amountUsd, ip } = args;

  assertVerifiedClient(user);

  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) {
    throw ApiError.badRequest('Investment amount must be a finite number.');
  }

  const amount = D(amountUsd);
  if (amount.decimalPlaces() > 2) {
    throw ApiError.badRequest('Investment amount may not have more than 2 decimal places.');
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw ApiError.badRequest('Investment amount must be greater than zero.');
  }

  const plan = await prisma.tradingPlan.findUnique({ where: { id: planId } });
  if (!plan) throw ApiError.notFound('That investment plan does not exist.');
  if (!plan.isActive) {
    throw ApiError.conflict('That investment plan is not currently open to new investments.');
  }

  const min = D(plan.minInvestment);
  const max = D(plan.maxInvestment);
  if (amount.lessThan(min)) {
    throw ApiError.badRequest(`The minimum investment for ${plan.name} is ${formatUsd(min)} USD.`);
  }
  if (amount.greaterThan(max)) {
    throw ApiError.badRequest(`The maximum investment for ${plan.name} is ${formatUsd(max)} USD.`);
  }

  // ── Atomic eligibility check + deployment ─────────────────────────────────
  // Same time-of-check/time-of-use race as the withdrawal path: two concurrent
  // requests both read the full available balance and both deploy, pushing
  // `deployed` past `credited` — the exact invalid ledger state the accounting
  // module logs as a bug. One transaction with the user row locked, so
  // allocations for one user are serialised (different users stay parallel).
  const now = new Date();
  const maturity = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  const investment = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

    const snapshot = await getAccountSnapshot(user.id, tx);
    if (amount.greaterThan(snapshot.withdrawableBalance)) {
      // Never invest money that is already deployed: the ledger's own
      // withdrawable balance is the authority on what is actually free.
      throw ApiError.insufficientFunds(
        `Only ${formatUsd(snapshot.withdrawableBalance)} USD is available to invest. ` +
          'Capital already deployed into an active investment cannot be invested again.',
      );
    }

    return tx.investment.create({
      data: {
        userId: user.id,
        planId: plan.id,
        capitalUsd: toPrismaDecimal(amount),
        currentValUsd: toPrismaDecimal(amount),
        status: 'ACTIVE',
        startDate: now,
        maturityDate: maturity,
      },
      include: { plan: true },
    });
  });

  await recordAudit({
    action: AUDIT.INVESTMENT_CREATED,
    userId: user.id,
    details: {
      investmentId: investment.id,
      planId: plan.id,
      planName: plan.name,
      amountUsd: amount.toNumber(),
      durationDays: plan.durationDays,
      maturityDate: maturity.toISOString(),
    },
    ipAddress: ip,
  });
  await recordAudit({
    action: AUDIT.INVESTMENT_ACTIVATED,
    userId: user.id,
    details: { investmentId: investment.id, planId: plan.id, amountUsd: amount.toNumber() },
    ipAddress: ip,
  });

  return toInvestmentDTO(investment);
}

// ─── positions ──────────────────────────────────────────────────────────────

/**
 * The stored live price for an OPEN position, or null.
 *
 * `TradeRecord` (prisma/schema.prisma) has NO `currentPrice` column, and the
 * broker sync does not invent one: `BrokerPosition.currentPrice` is published to
 * the socket stream for live UI updates, but the only per-position values the
 * sync persists are the broker-reported costs. So there is nothing to read here
 * today and the honest answer is `null`.
 *
 * What this function must NEVER do — and does not — is fall back to
 * `entryPrice`, or compute a "current" price from a P/L figure. An unknown price
 * is reported as unknown; the client renders a dash.
 */
function storedCurrentPrice(): number | null {
  return null;
}

/**
 * Floating P/L of an OPEN position, as recorded by the broker sync.
 *
 * The sync writes broker figures into the row's P/L columns only when the broker
 * reported them (see `upsertOpenTradeRecord`: P/L columns keep their schema
 * defaults until a deal reports a result). `grossPnL` is therefore the only
 * place a live figure could legitimately land, and an OPEN row the sync has not
 * enriched reads as 0 — "no result recorded yet", never a derived estimate.
 * Nothing here multiplies a price difference by contract size to manufacture a
 * floating number: a fabricated P/L on a live position is exactly the kind of
 * number this platform refuses to show.
 */
function storedOpenFloatingPnL(trade: TradeRecord): number {
  return num(trade.grossPnL);
}

function toPositionDTO(trade: TradeRecord): PositionDTO {
  const isOpen = trade.status === 'OPEN';

  return {
    id: trade.id,
    metaApiPositionId: trade.metaApiPositionId,
    investmentId: trade.investmentId,
    instrument: trade.instrument,
    direction: trade.direction,
    volume: num(trade.volume),
    entryPrice: num(trade.entryPrice),
    // OPEN → the broker's live price when the sync has stored one, else null.
    // CLOSED → the exit the broker actually filled, else null.
    currentPrice: isOpen ? storedCurrentPrice() : trade.exitPrice === null ? null : num(trade.exitPrice),
    exitPrice: trade.exitPrice === null ? null : num(trade.exitPrice),
    stopLoss: trade.stopLoss === null ? null : num(trade.stopLoss),
    takeProfit: trade.takeProfit === null ? null : num(trade.takeProfit),
    grossPnL: num(trade.grossPnL),
    commission: num(trade.commission),
    swap: num(trade.swap),
    netPnL: num(trade.netPnL),
    // OPEN → the row's recorded unrealised P/L; CLOSED → the booked result.
    floatingPnL: isOpen ? storedOpenFloatingPnL(trade) : num(trade.netPnL),
    status: trade.status,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt?.toISOString() ?? null,
  };
}

/**
 * Every position belonging to the caller, OPEN first then CLOSED, each mapped
 * with the value that status actually has.
 */
export async function listPositions(userId: string): Promise<PositionDTO[]> {
  const trades = await prisma.tradeRecord.findMany({
    where: { investment: { userId } },
    // 'OPEN' sorts after 'CLOSED'/'CANCELLED' descending, so live positions lead.
    orderBy: [{ status: 'desc' }, { openedAt: 'desc' }],
  });
  return trades.map(toPositionDTO);
}

// ─── trades ─────────────────────────────────────────────────────────────────

function toTradeDTO(trade: TradeRecord): TradeDTO {
  return {
    id: trade.id,
    investmentId: trade.investmentId,
    metaApiPositionId: trade.metaApiPositionId,
    instrument: trade.instrument,
    direction: trade.direction,
    volume: num(trade.volume),
    entryPrice: num(trade.entryPrice),
    exitPrice: trade.exitPrice === null ? null : num(trade.exitPrice),
    stopLoss: trade.stopLoss === null ? null : num(trade.stopLoss),
    takeProfit: trade.takeProfit === null ? null : num(trade.takeProfit),
    grossPnL: num(trade.grossPnL),
    commission: num(trade.commission),
    swap: num(trade.swap),
    netPnL: num(trade.netPnL),
    status: trade.status,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt?.toISOString() ?? null,
  };
}

export interface ListTradesOptions {
  status?: string;
  take?: number;
  cursor?: string;
}

/**
 * Cursor-paginated trade history, newest first. Fetches `take + 1` rows so the
 * presence of a next page is known without a second count query.
 */
export async function listTrades(
  userId: string,
  options: ListTradesOptions = {},
): Promise<Paginated<TradeDTO>> {
  const take = Math.min(Math.max(options.take ?? 50, 1), 200);

  const rows = await prisma.tradeRecord.findMany({
    where: {
      investment: { userId },
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { openedAt: 'desc' },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    items: page.map(toTradeDTO),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ─── activity feed ──────────────────────────────────────────────────────────

type Severity = ActivityEventDTO['severity'];

interface ActivityTemplate {
  message: (details: Record<string, unknown>) => string;
  severity: Severity;
}

function str(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function amount(details: Record<string, unknown>, key = 'amountUsd'): string | null {
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) ? `$${formatUsd(value)}` : null;
}

/** Appends a verified detail to a message when the audit row carries one. */
function withSuffix(base: string, suffix: string | null): string {
  return suffix ? `${base} (${suffix})` : base;
}

function always(message: string, severity: Severity): ActivityTemplate {
  return { message: () => message, severity };
}

/**
 * ACTION → human message + severity.
 *
 * Exhaustive over `AUDIT` (the `Record<AuditAction, …>` annotation makes a new
 * audit constant a compile error until it is mapped here). The fallback for an
 * action that is not in the map — a row written by a newer deploy, or by a
 * module that has not been mapped yet — is the raw action string at severity
 * 'info': the audit table is the source of truth, and a feed item is never
 * invented for an event that is not in it.
 */
const ACTIVITY_TEMPLATES: Record<AuditAction, ActivityTemplate> = {
  // auth
  AUTH_REGISTERED: always('Account created', 'success'),
  AUTH_LOGIN_SUCCESS: always('Signed in', 'success'),
  AUTH_LOGIN_FAILED: always('Failed sign-in attempt', 'warning'),
  AUTH_LOGOUT: always('Signed out', 'info'),
  AUTH_2FA_ENABLED: always('Two-factor authentication enabled', 'success'),
  AUTH_2FA_DISABLED: always('Two-factor authentication disabled', 'warning'),
  AUTH_2FA_CHALLENGE_FAILED: always('Two-factor verification failed', 'warning'),
  AUTH_TOKEN_REFRESHED: always('Session refreshed', 'info'),
  AUTH_PASSWORD_CHANGED: always('Password changed', 'warning'),
  AUTH_PASSWORD_CHANGE_FAILED: always('Password change rejected', 'warning'),

  // kyc
  KYC_SUBMITTED: always('Identity documents submitted', 'info'),
  KYC_RESUBMITTED: always('Identity documents resubmitted', 'info'),
  KYC_REVIEW_STARTED: always('Compliance review started', 'info'),
  KYC_APPROVED: always('Identity verified', 'success'),
  KYC_REJECTED: {
    message: (d) => withSuffix('Identity verification rejected', str(d, 'reason')),
    severity: 'error',
  },
  KYC_ADDITIONAL_INFO_REQUESTED: {
    message: (d) => withSuffix('Additional information requested', str(d, 'reason')),
    severity: 'warning',
  },
  KYC_DOCUMENT_VIEWED: always('Identity document opened by compliance', 'info'),

  // payments in
  DEPOSIT_CREATED: {
    message: (d) => withSuffix('Deposit address issued', amount(d)),
    severity: 'info',
  },
  DEPOSIT_IPN_RECEIVED: always('Deposit confirmation received from the provider', 'info'),
  DEPOSIT_IPN_REJECTED: {
    message: (d) => withSuffix('Deposit confirmation rejected', str(d, 'reason')),
    severity: 'warning',
  },
  DEPOSIT_CONFIRMED: {
    message: (d) => withSuffix('Deposit confirmed', amount(d)),
    severity: 'success',
  },
  DEPOSIT_FAILED: {
    message: (d) => withSuffix('Deposit failed', str(d, 'reason')),
    severity: 'error',
  },

  // payments out
  WITHDRAWAL_REQUESTED: {
    message: (d) => withSuffix('Withdrawal requested', amount(d)),
    severity: 'info',
  },
  WITHDRAWAL_APPROVED: {
    message: (d) => withSuffix('Withdrawal approved', amount(d)),
    severity: 'success',
  },
  WITHDRAWAL_REJECTED: {
    message: (d) => withSuffix('Withdrawal rejected', str(d, 'reason')),
    severity: 'error',
  },
  WITHDRAWAL_BROADCAST: always('Withdrawal broadcast to the network', 'success'),
  WITHDRAWAL_FAILED: {
    message: (d) => withSuffix('Withdrawal failed', str(d, 'reason')),
    severity: 'error',
  },

  // investments
  INVESTMENT_CREATED: {
    message: (d) => withSuffix('Investment created', amount(d)),
    severity: 'info',
  },
  INVESTMENT_ACTIVATED: always('Investment activated', 'success'),
  INVESTMENT_PAUSED: always('Investment paused', 'warning'),
  INVESTMENT_CLOSED: always('Investment closed', 'info'),
  INVESTMENT_MATURED: always('Investment reached maturity', 'info'),

  // broker
  BROKER_CONNECTED: always('Broker account connected', 'success'),
  BROKER_DISCONNECTED: always('Broker account disconnected', 'warning'),
  BROKER_ERROR: {
    message: (d) => withSuffix('Broker error', str(d, 'message') ?? str(d, 'reason')),
    severity: 'error',
  },
  BROKER_ADDED: always('Broker account added', 'info'),
  BROKER_ORDER_SUBMITTED: always('Order submitted to the broker', 'info'),
  BROKER_ORDER_FILLED: always('Order filled by the broker', 'success'),
  BROKER_ORDER_REJECTED: {
    message: (d) => withSuffix('Order rejected by the broker', str(d, 'reason')),
    severity: 'error',
  },
  BROKER_POSITION_CLOSED: always('Position closed by the broker', 'info'),

  // risk / bot
  RISK_CHECK_PASSED: always('Risk check passed', 'info'),
  RISK_CHECK_FAILED: {
    message: (d) => withSuffix('Risk check failed', str(d, 'reason')),
    severity: 'warning',
  },
  RISK_DRAWDOWN_BREACH: always('Drawdown limit breached', 'error'),
  RISK_KILL_SWITCH: always('Trading kill switch engaged', 'error'),
  BOT_SIGNAL_TRIGGERED: always('Strategy signal triggered', 'info'),
  BOT_STARTED: always('Strategy engine started', 'info'),
  BOT_STOPPED: always('Strategy engine stopped', 'info'),
  LOT_ALLOCATED: always('Capital allocated to a position', 'info'),

  // admin
  PLAN_CREATED: always('Investment plan created', 'info'),
  PLAN_UPDATED: always('Investment plan updated', 'info'),
  PLAN_DEACTIVATED: always('Investment plan deactivated', 'warning'),
  ADMIN_USER_ROLE_CHANGED: always('Account role changed', 'warning'),
  ADMIN_SETTINGS_UPDATED: always('Platform settings updated', 'info'),
  ADMIN_TRADE_FORCE_CLOSED: always('Trade force-closed by an operator', 'warning'),
};

function templateFor(action: string): ActivityTemplate {
  if (Object.prototype.hasOwnProperty.call(ACTIVITY_TEMPLATES, action)) {
    return ACTIVITY_TEMPLATES[action as AuditAction];
  }
  return { message: () => action, severity: 'info' };
}

/** AuditLog.details is Json; anything that is not an object reads as empty. */
function asDetails(value: Prisma.JsonValue): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * The caller's own activity feed, straight out of the append-only audit table.
 * No synthesised "market" events, no placeholder rows.
 */
export async function listActivity(userId: string, take = 50): Promise<ActivityEventDTO[]> {
  const rows = await listAudit({ userId, take: Math.min(Math.max(take, 1), 200) });

  return rows.map((row) => {
    const details = asDetails(row.details);
    const template = templateFor(row.action);
    return {
      id: row.id,
      action: row.action,
      message: template.message(details),
      severity: template.severity,
      details,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

// ─── plans ──────────────────────────────────────────────────────────────────

function toPlanDTO(plan: TradingPlan, stats: TradingPlanDTO['stats']): TradingPlanDTO {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    minInvestment: num(plan.minInvestment),
    maxInvestment: num(plan.maxInvestment),
    durationDays: plan.durationDays,
    targetReturnMin: num(plan.targetReturnMin),
    targetReturnMax: num(plan.targetReturnMax),
    riskLevel: plan.riskLevel,
    performanceFee: num(plan.performanceFee),
    managementFee: num(plan.managementFee),
    maxDrawdown: num(plan.maxDrawdown),
    isActive: plan.isActive,
    targetReturnLabel: TARGET_RETURN_LABEL,
    stats,
  };
}

/**
 * The public plan list — the same payload the marketing site and the dashboard
 * plan-picker render, so a target return cannot appear in one place without the
 * label that qualifies it.
 *
 * `stats` is `null` for a plan with no closed trades: a win rate of 0% would
 * read as failure and 100% as a promise, and neither is a fact.
 */
export async function listActivePlans(): Promise<TradingPlanDTO[]> {
  const plans = await prisma.tradingPlan.findMany({
    where: { isActive: true },
    orderBy: [{ minInvestment: 'asc' }, { name: 'asc' }],
  });

  return Promise.all(
    plans.map(async (plan) => toPlanDTO(plan, await getStrategyStats(plan.id))),
  );
}