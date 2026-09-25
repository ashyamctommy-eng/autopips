import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { D, sum, usd, type Numeric, Decimal } from '@/lib/money';
import {
  computeEquity,
  computeWithdrawableBalance,
  CREDITED_PAYMENT_STATUSES,
  DEBITED_PAYMENT_STATUSES,
  type EquityBreakdown,
  type EquityInputs,
} from './equity';

/**
 * Ledger aggregation: the ONLY place SQL is turned into equity numbers.
 *
 * Every route that reports a balance (client overview, admin AUM, withdrawal
 * eligibility) goes through here, so the accounting formula is applied
 * identically everywhere and there is exactly one place to audit.
 *
 * Nothing in this file computes a number from anything other than persisted
 * rows. There is no cache, no default, and no fallback that could show a value
 * the ledger does not support.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `buildEquityFromAggregates` EXISTS (do not inline this arithmetic)
 * ─────────────────────────────────────────────────────────────────────────────
 * The equity identity is easy to get subtly wrong, and it once was: three
 * separate copies of this assembly existed (here, in the payments service, and
 * in the admin service), and one of them built the idle-cash term from
 * already-net capital and then subtracted withdrawals a second time.
 *
 * So the arithmetic now lives in exactly ONE exported pure function that every
 * caller — single user or batch — must use. If you need equity for a new shape
 * of query, add the aggregates and call this; do not re-derive the formula.
 */

/** Withdrawal states where the money is committed but not yet paid. */
export const IN_FLIGHT_WITHDRAWAL_STATUSES = [
  'PENDING',
  'WAITING',
  'CONFIRMED',
  'SENDING',
] as const;

/** Investment states whose capital is deployed with the broker. */
export const DEPLOYED_INVESTMENT_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/**
 * Raw, verified ledger aggregates for one account or the whole platform.
 * Construction is the caller's job; interpretation is not.
 */
export interface LedgerAggregates {
  /** Σ Deposit.amountUsd WHERE status ∈ {CONFIRMED, FINISHED} */
  creditedDeposits: Numeric;
  /** Σ Withdrawal.amountUsd WHERE status = FINISHED */
  paidWithdrawals: Numeric;
  /** Σ Investment.capitalUsd WHERE status ∈ {ACTIVE, PAUSED} */
  deployedCapital: Numeric;
  /** Σ TradeRecord.netPnL WHERE status = CLOSED */
  realizedPnL: Numeric;
  /** Σ Investment.unrealizedPnL (broker-written) */
  unrealizedPnL: Numeric;
  /** Σ Investment.feesDeducted */
  deductedFees: Numeric;
}

/**
 * THE single application of the accounting formula.
 *
 * Idle capital is `credited − deployed` (GROSS deposits less what is deployed).
 * Withdrawals are then subtracted by `computeEquity` via the `withdrawals` input.
 * Deriving idle from net capital here would debit withdrawals twice.
 */
export function buildEquityFromAggregates(agg: LedgerAggregates): EquityBreakdown {
  const credited = D(agg.creditedDeposits);
  const paid = D(agg.paidWithdrawals);
  const deployed = D(agg.deployedCapital);

  // Clamped to zero only as a defensive guard: in a well-formed ledger deposits
  // cannot be deployed without having been credited first, so `credited` is
  // always >= `deployed`. A negative here would mean an allocation was recorded
  // against capital that was never funded, which is a bug worth failing loudly on.
  const idle = credited.minus(deployed);
  if (idle.lessThan(0)) {
    console.error(
      `[ledger] deployed capital (${deployed.toString()}) exceeds credited deposits (${credited.toString()}). ` +
        'An investment appears to be funded by capital that was never credited.',
    );
  }
  const unallocated = usd(idle.lessThan(0) ? 0 : idle);

  const inputs: EquityInputs = {
    startingCapital: deployed,
    confirmedDeposits: unallocated,
    realizedPnL: agg.realizedPnL,
    unrealizedPnL: agg.unrealizedPnL,
    deductedFees: agg.deductedFees,
    withdrawals: paid,
    // Return is measured against the money the client actually put in, net of
    // what they took out. Falls back to deployed capital when nothing is net in.
    returnBase: credited.minus(paid).greaterThan(0) ? credited.minus(paid) : deployed,
  };

  return computeEquity(inputs);
}

export interface AccountSnapshot {
  userId: string;
  breakdown: EquityBreakdown;
  /** Capital currently deployed in ACTIVE/PAUSED investments. */
  activeCapital: Decimal;
  /** Withdrawals requested but not yet paid. */
  pendingWithdrawals: Decimal;
  /** Equity minus deployed capital minus pending withdrawals. */
  withdrawableBalance: Decimal;
  openInvestments: number;
  /** Gross confirmed deposits ever credited (display / audit only). */
  totalCreditedDeposits: Decimal;
  /** Gross finished withdrawals ever paid (display / audit only). */
  totalPaidWithdrawals: Decimal;
  /** Confirmed deposits − finished withdrawals. */
  netContributedCapital: Decimal;
}

/**
 * Any Prisma executor: the global client, or a transaction client.
 *
 * Money-moving callers pass a TRANSACTION client so the read of this snapshot
 * and the write that depends on it happen atomically under a row lock. Without
 * that, two concurrent requests both read `withdrawableBalance = 600` and both
 * succeed, reserving 1200 of a 600 balance (verified race — see D7/D8).
 */
export type Db = Prisma.TransactionClient | typeof prisma;

/** Prisma `.aggregate` returns `Decimal | null`; normalise without inventing. */
function agg(value: Decimal | null | undefined): Decimal {
  return value === null || value === undefined ? new Decimal(0) : new Decimal(value);
}

/**
 * Full, verified ledger picture for one user.
 *
 * Sources:
 *   startingCapital   ← Investment.capitalUsd (ACTIVE/PAUSED)   [deployed]
 *   confirmedDeposits ← credited deposits − deployed            [idle]
 *   realizedPnL       ← sum(TradeRecord.netPnL WHERE status='CLOSED')
 *   unrealizedPnL     ← sum(Investment.unrealizedPnL)   [broker-sourced]
 *   deductedFees      ← sum(Investment.feesDeducted)
 *   withdrawals       ← sum(Withdrawal.amountUsd WHERE status='FINISHED')
 */
export async function getAccountSnapshot(
  userId: string,
  db: Db = prisma,
): Promise<AccountSnapshot> {
  const [
    portfolio,
    closedTrades,
    finishedWithdrawals,
    pendingWithdrawals,
    creditedDeposits,
    openInvestments,
  ] = await Promise.all([
    // CANCELLED investments carry no realisable P/L or charged fees; the admin
    // projection excludes them too, so excluding them here keeps the two
    // surfaces identical (a mismatch was verified as defect D5).
    db.investment.aggregate({
      where: { userId, status: { not: 'CANCELLED' } },
      _sum: { unrealizedPnL: true, feesDeducted: true },
    }),
    db.tradeRecord.aggregate({
      where: { investment: { userId }, status: 'CLOSED' },
      _sum: { netPnL: true },
    }),
    db.withdrawal.aggregate({
      where: { userId, status: { in: [...DEBITED_PAYMENT_STATUSES] } },
      _sum: { amountUsd: true },
    }),
    db.withdrawal.aggregate({
      where: { userId, status: { in: [...IN_FLIGHT_WITHDRAWAL_STATUSES] } },
      _sum: { amountUsd: true },
    }),
    db.deposit.aggregate({
      where: { userId, status: { in: [...CREDITED_PAYMENT_STATUSES] } },
      _sum: { amountUsd: true },
    }),
    db.investment.aggregate({
      where: { userId, status: { in: [...DEPLOYED_INVESTMENT_STATUSES] } },
      _sum: { capitalUsd: true },
      _count: { _all: true },
    }),
  ]);

  const credited = agg(creditedDeposits._sum.amountUsd);
  const paidWithdrawals = agg(finishedWithdrawals._sum.amountUsd);
  const deployedCapital = agg(openInvestments._sum.capitalUsd);

  const breakdown = buildEquityFromAggregates({
    creditedDeposits: credited,
    paidWithdrawals,
    deployedCapital,
    realizedPnL: agg(closedTrades._sum.netPnL),
    unrealizedPnL: agg(portfolio._sum.unrealizedPnL),
    deductedFees: agg(portfolio._sum.feesDeducted),
  });

  const pending = agg(pendingWithdrawals._sum.amountUsd);

  return {
    userId,
    breakdown,
    activeCapital: deployedCapital,
    pendingWithdrawals: pending,
    withdrawableBalance: computeWithdrawableBalance({
      equity: breakdown.equity,
      activeCapital: deployedCapital,
      pendingWithdrawals: pending,
    }),
    openInvestments: openInvestments._count._all,
    totalCreditedDeposits: credited,
    totalPaidWithdrawals: paidWithdrawals,
    netContributedCapital: usd(credited.minus(paidWithdrawals)),
  };
}

export interface PlatformLedger {
  /** Deployed capital across every client — the AUM figure. */
  totalManagedCapital: Decimal;
  /** Sum of equity contributed by every client's ledger. */
  totalEquity: Decimal;
  realizedPnL: Decimal;
  unrealizedPnL: Decimal;
  deductedFees: Decimal;
  withdrawalsPaid: Decimal;
  confirmedDeposits: Decimal;
  activeClients: number;
  openInvestments: number;
}

/**
 * Platform-wide ledger for the admin AUM dashboard.
 *
 * Uses the same `buildEquityFromAggregates` as the per-client path, so the
 * platform total cannot drift from the sum of the client views.
 */
export async function getPlatformLedger(): Promise<PlatformLedger> {
  const [
    portfolio,
    closedTrades,
    finishedWithdrawals,
    creditedDeposits,
    activeClients,
    openInvestments,
  ] = await Promise.all([
    // Consistent with the per-user path and the admin projection (see D5).
    prisma.investment.aggregate({
      where: { status: { not: 'CANCELLED' } },
      _sum: { unrealizedPnL: true, feesDeducted: true },
    }),
    prisma.tradeRecord.aggregate({
      where: { status: 'CLOSED' },
      _sum: { netPnL: true },
    }),
    prisma.withdrawal.aggregate({
      where: { status: { in: [...DEBITED_PAYMENT_STATUSES] } },
      _sum: { amountUsd: true },
    }),
    prisma.deposit.aggregate({
      where: { status: { in: [...CREDITED_PAYMENT_STATUSES] } },
      _sum: { amountUsd: true },
    }),
    prisma.user.count({ where: { role: 'CLIENT', kycStatus: 'APPROVED' } }),
    prisma.investment.aggregate({
      where: { status: { in: [...DEPLOYED_INVESTMENT_STATUSES] } },
      _sum: { capitalUsd: true },
      _count: { _all: true },
    }),
  ]);

  const credited = agg(creditedDeposits._sum.amountUsd);
  const paidWithdrawals = agg(finishedWithdrawals._sum.amountUsd);
  const deployedCapital = agg(openInvestments._sum.capitalUsd);

  const breakdown = buildEquityFromAggregates({
    creditedDeposits: credited,
    paidWithdrawals,
    deployedCapital,
    realizedPnL: agg(closedTrades._sum.netPnL),
    unrealizedPnL: agg(portfolio._sum.unrealizedPnL),
    deductedFees: agg(portfolio._sum.feesDeducted),
  });

  return {
    totalManagedCapital: usd(deployedCapital),
    totalEquity: breakdown.equity,
    realizedPnL: breakdown.realizedPnL,
    unrealizedPnL: breakdown.unrealizedPnL,
    deductedFees: breakdown.deductedFees,
    withdrawalsPaid: usd(paidWithdrawals),
    confirmedDeposits: usd(credited),
    activeClients,
    openInvestments: openInvestments._count._all,
  };
}

/** Realised P/L booked today, from CLOSED trade records only. */
export async function getRealizedPnlToday(): Promise<Decimal> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const result = await prisma.tradeRecord.aggregate({
    where: { status: 'CLOSED', closedAt: { gte: startOfDay } },
    _sum: { netPnL: true },
  });
  return usd(agg(result._sum.netPnL));
}

/** Open market exposure: notional value of positions currently open. */
/**
 * Open market exposure, in USD.
 *
 * Prefers the broker's OWN notional when the row carries one. That matters for
 * stake-denominated contracts: a Deriv multiplier's exposure is stake ×
 * multiplier, while `volume` holds the stake, so `volume × entryPrice` would
 * overstate it by a factor of the entry price (a $100 stake on gold at 4270
 * reads as $427,000 instead of the $10,000 it is at 100×).
 *
 * Falls back to volume × entryPrice, which is exactly right for a
 * lot-denominated broker — so both shapes are represented honestly instead of
 * one being coerced into the other.
 */
export async function getOpenExposure(): Promise<{ notional: Decimal; positions: number }> {
  const open = await prisma.tradeRecord.findMany({
    where: { status: 'OPEN' },
    select: { volume: true, entryPrice: true, notional: true },
  });

  const notional = sum(
    open.map((p) =>
      p.notional === null || p.notional === undefined
        ? D(p.volume).times(D(p.entryPrice))
        : D(p.notional),
    ),
  );

  return { notional: usd(notional), positions: open.length };
}

/** Re-export for callers that already import the ledger. */
export { computeEquity, computeWithdrawableBalance };
export { CREDITED_PAYMENT_STATUSES, DEBITED_PAYMENT_STATUSES };
export type { EquityBreakdown, EquityInputs };
