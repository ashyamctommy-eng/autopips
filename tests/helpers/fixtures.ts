import crypto from 'node:crypto';
import './test-env';
import { prisma } from '@/lib/prisma';
import type { User } from '@prisma/client';

/**
 * Fixture helpers for the LIVE DATABASE integration tests.
 *
 * SAFETY CONTRACT (why this file exists):
 *   * Every row this suite creates is tagged with a per-run unique prefix
 *     (`verify-suite-<runid>-`) on fields we can search on:
 *        User.email, TradingPlan.name, BrokerConnection.metaApiAccountId.
 *   * `purgeFixtures()` deletes ONLY rows carrying the prefix, in FK-safe order,
 *     and reports how many rows each step removed.
 *   * `assertNoFixtureRowsLeft()` re-counts every table afterwards so a failed
 *     cleanup is a loud test failure, never silent pollution of the demo data.
 */

/** Stable tag shared by every fixture row created by this run. */
export const FIXTURE_TAG = `verify-suite-${crypto.randomUUID().slice(0, 8)}`;

export const FIXTURE_EMAIL_PREFIX = FIXTURE_TAG;
export const FIXTURE_PLAN_NAME_PREFIX = FIXTURE_TAG;
export const FIXTURE_ACCOUNT_PREFIX = FIXTURE_TAG;

let emailCounter = 0;

/** Unique fixture email — never a real domain (`.invalid` is RFC-2606 reserved). */
export function fixtureEmail(label: string): string {
  emailCounter += 1;
  return `${FIXTURE_EMAIL_PREFIX}-${label}-${emailCounter}@fixture.invalid`;
}

export function fixturePaymentId(label: string): string {
  return `${FIXTURE_TAG}-payment-${label}-${crypto.randomUUID()}`;
}

export function fixtureMetaApiAccountId(label: string): string {
  return `${FIXTURE_ACCOUNT_PREFIX}-acct-${label}-${crypto.randomUUID()}`;
}

/** All fixture-owned broker-connection ids, so Redis keys can be cleaned too. */
const createdBrokerConnectionIds = new Set<string>();
export function trackBrokerConnection(id: string): void {
  createdBrokerConnectionIds.add(id);
}

/** Redis keys written by the code under test for fixture investments. */
const createdRedisKeys = new Set<string>();
export function trackRedisKey(key: string): void {
  createdRedisKeys.add(key);
}

export async function isDatabaseReachable(): Promise<boolean> {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.length === 0) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.warn(
      `[fixtures] Postgres unreachable (${
        error instanceof Error ? error.message.trim().split('\n').join(' ').slice(0, 160) : String(error)
      }) — DB-backed tests will be skipped.`,
    );
    return false;
  }
}

export async function isRedisReachable(): Promise<boolean> {
  try {
    const { redis } = await import('@/lib/redis');
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    console.warn(
      `[fixtures] Redis unreachable (${
        error instanceof Error ? error.message.trim().split('\n').join(' ').slice(0, 160) : String(error)
      }) — Redis-backed tests will be skipped.`,
    );
    return false;
  }
}

export interface PurgeReport {
  tradeRecords: number;
  auditLogs: number;
  deposits: number;
  withdrawals: number;
  investments: number;
  brokerConnections: number;
  users: number;
  plans: number;
  redisKeys: number;
}

/**
 * Delete every row created by this fixture run, in FK-safe order.
 *
 * TradeRecord rows are removed explicitly (they also cascade from Investment,
 * but deleting them first makes the counts honest). AuditLog has no cascade, so
 * it must go before its User. BrokerConnection is referenced by TradeRecord via
 * a non-cascading FK, so trades go first.
 */
export async function purgeFixtures(): Promise<PurgeReport> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const investments = userIds.length
    ? await prisma.investment.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
    : [];
  const investmentIds = investments.map((i) => i.id);

  const tradeRecords = investmentIds.length
    ? (await prisma.tradeRecord.deleteMany({ where: { investmentId: { in: investmentIds } } })).count
    : 0;

  const auditLogs = userIds.length
    ? (await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })).count
    : 0;

  const deposits = userIds.length
    ? (await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } })).count
    : 0;

  const withdrawals = userIds.length
    ? (await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } })).count
    : 0;

  const removedInvestments = userIds.length
    ? (await prisma.investment.deleteMany({ where: { userId: { in: userIds } } })).count
    : 0;

  const brokerConnections = await prisma.brokerConnection.deleteMany({
    where: { metaApiAccountId: { startsWith: FIXTURE_ACCOUNT_PREFIX } },
  });

  const removedUsers = await prisma.user.deleteMany({ where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } } });

  const plans = await prisma.tradingPlan.deleteMany({ where: { name: { startsWith: FIXTURE_PLAN_NAME_PREFIX } } });

  let redisKeys = 0;
  if (createdRedisKeys.size > 0) {
    try {
      const { redis } = await import('@/lib/redis');
      redisKeys = await redis.del(...Array.from(createdRedisKeys));
    } catch (error) {
      console.warn(`[fixtures] Redis key cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    createdRedisKeys.clear();
  }
  createdBrokerConnectionIds.clear();

  return {
    tradeRecords,
    auditLogs,
    deposits,
    withdrawals,
    investments: removedInvestments,
    brokerConnections: brokerConnections.count,
    users: removedUsers.count,
    plans: plans.count,
    redisKeys,
  };
}

export interface FixtureResidue {
  users: number;
  plans: number;
  brokerConnections: number;
  investments: number;
  deposits: number;
  withdrawals: number;
  tradeRecords: number;
  auditLogs: number;
}

/** Count every row that could still carry our fixture tag. Must be all zeros. */
export async function countFixtureResidue(): Promise<FixtureResidue> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const [plans, brokerConnections, investments, deposits, withdrawals, tradeRecords, auditLogs] = await Promise.all([
    prisma.tradingPlan.count({ where: { name: { startsWith: FIXTURE_PLAN_NAME_PREFIX } } }),
    prisma.brokerConnection.count({ where: { metaApiAccountId: { startsWith: FIXTURE_ACCOUNT_PREFIX } } }),
    prisma.investment.count({ where: { userId: { in: userIds } } }),
    prisma.deposit.count({ where: { userId: { in: userIds } } }),
    prisma.withdrawal.count({ where: { userId: { in: userIds } } }),
    prisma.tradeRecord.count({ where: { investment: { userId: { in: userIds } } } }),
    prisma.auditLog.count({ where: { userId: { in: userIds } } }),
  ]);

  return {
    users: users.length,
    plans,
    brokerConnections,
    investments,
    deposits,
    withdrawals,
    tradeRecords,
    auditLogs,
  };
}

export async function assertNoFixtureRowsLeft(): Promise<void> {
  const residue = await countFixtureResidue();
  const offending = Object.entries(residue).filter(([, count]) => count !== 0);
  if (offending.length > 0) {
    throw new Error(
      `Fixture cleanup left rows behind (tag ${FIXTURE_TAG}): ${offending
        .map(([table, count]) => `${table}=${count}`)
        .join(', ')}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Shared fixture builders (used by more than one integration file)            */
/* -------------------------------------------------------------------------- */

/** A syntactically valid TRC20 payout address (34 chars, base58check shape). */
export const TRON_PAYOUT_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

export interface FixtureUserOptions {
  role?: 'CLIENT' | 'ADMIN' | 'TRADING_MANAGER';
  kycStatus?: 'NOT_SUBMITTED' | 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ADDITIONAL_INFO_REQUIRED';
}

/**
 * A KYC-approved fixture user (client by default, staff when asked).
 *
 * `passwordHash` is a real Argon2id hash of a throwaway password so the row is
 * shaped exactly like one produced by registration; it is never used to log in.
 */
export async function createFixtureUser(
  label: string,
  opts: FixtureUserOptions = {},
): Promise<User> {
  const { hashPassword } = await import('@/server/modules/auth/password.service');
  return prisma.user.create({
    data: {
      email: fixtureEmail(label),
      passwordHash: await hashPassword('fixture-password-not-used-anywhere-1!'),
      fullName: `Verify Suite ${label}`,
      country: 'KE',
      role: opts.role ?? 'CLIENT',
      kycStatus: opts.kycStatus ?? 'APPROVED',
    },
  });
}

/** An ACTIVE, investable fixture plan sized for the standard 1,000.00 scenario. */
export async function createFixturePlan(label: string, isActive = true) {
  return prisma.tradingPlan.create({
    data: {
      name: `${FIXTURE_TAG} ${label} plan`,
      description: 'verification-suite scenario plan',
      minInvestment: '100.00',
      maxInvestment: '1000000.00',
      durationDays: 90,
      targetReturnMin: '5.00',
      targetReturnMax: '12.00',
      riskLevel: 'MEDIUM',
      performanceFee: '20.00',
      managementFee: '1.50',
      maxDrawdown: '15.00',
      isActive,
    },
  });
}

/** Pending deposit row, exactly as `createDeposit` persists it after the
 *  provider round-trip. Crediting it is the IPN handler's job, not this
 *  helper's — the money only ever moves through verified IPN callbacks. */
export async function createPendingDeposit(userId: string, amountUsd: string, label: string) {
  return prisma.deposit.create({
    data: {
      userId,
      amountUsd,
      cryptoCurrency: 'usdttrc20',
      paymentId: fixturePaymentId(label),
      depositAddress: `T${FIXTURE_TAG}${label}Address`,
      payAmount: amountUsd,
      status: 'PENDING',
    },
  });
}
