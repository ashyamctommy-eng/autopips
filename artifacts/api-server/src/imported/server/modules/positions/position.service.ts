import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { serverEnv } from '@/lib/env';
import { D, toPrismaDecimal, usd, type Decimal } from '@/lib/money';
import { normaliseMarketSymbol } from '@/lib/contracts';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import type { InternalPositionDTO, WalletDTO } from '@/types/api';
import type { Position } from '@prisma/client';
import {
  computePositionPnl,
  isProtectivePairSane,
  positionExitTrigger,
  type PositionSideValue,
} from './position.math';

/**
 * INTERNAL POSITION ENGINE (`EXECUTION_MODE=internal`).
 *
 * The platform is the counterparty: a position is a platform liability priced off
 * the market-data feed, with no broker order behind it. Two invariants govern
 * everything here:
 *
 *   1. THE LEDGER IS THE ONLY SOURCE OF MONEY. Opening a position reserves
 *      `stake` out of the client's withdrawable balance — it does NOT touch a
 *      balance column (there isn't one). The ledger reads an OPEN position's
 *      stake as DEPLOYED capital and its pnl as a P/L term, so the wallet, the
 *      dashboard, the admin view and the equity formula can never disagree.
 *   2. A CLIENT CAN NEVER LOSE MORE THAN THE STAKE. P&L is clamped at −stake
 *      (see position.math). That is what makes an internal book bounded.
 *
 * The mode gate is deliberately fail-closed: while `EXECUTION_MODE != internal`
 * every open/close is refused, so turning the engine on is an explicit act and
 * turning it off restores the previous behaviour immediately.
 */

export const POSITION_MIN_STAKE_USD = 1;
export const POSITION_MAX_STAKE_USD = 25_000;
export const POSITION_MAX_MULTIPLIER = 100;

/** Which venue trades are booked on. Defaults to `broker` (previous behaviour). */
export function executionMode(): 'internal' | 'broker' {
  return serverEnv().EXECUTION_MODE;
}

export function isInternalExecutionEnabled(): boolean {
  return executionMode() === 'internal';
}

function assertInternalExecution(): void {
  if (!isInternalExecutionEnabled()) {
    throw ApiError.forbidden(
      'Internal execution is disabled on this deployment (EXECUTION_MODE is not "internal").',
    );
  }
}

/* ─────────────────────────────── validation ──────────────────────────────── */

function assertStake(stakeUsd: number): Decimal {
  if (typeof stakeUsd !== 'number' || !Number.isFinite(stakeUsd)) {
    throw ApiError.badRequest('Stake must be a finite number.');
  }
  const stake = D(stakeUsd);
  if (stake.decimalPlaces() > 2) throw ApiError.badRequest('Stake may not have more than 2 decimal places.');
  if (stake.lessThan(POSITION_MIN_STAKE_USD)) {
    throw ApiError.badRequest(`Minimum stake is $${POSITION_MIN_STAKE_USD.toFixed(2)}.`);
  }
  if (stake.greaterThan(POSITION_MAX_STAKE_USD)) {
    throw ApiError.badRequest(`Maximum stake is $${POSITION_MAX_STAKE_USD.toFixed(2)}.`);
  }
  return stake;
}

function assertPrice(value: number, label: string): Decimal {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw ApiError.badRequest(`${label} must be a positive, finite number.`);
  }
  return D(value);
}

function assertMultiplier(value: number | undefined): Decimal {
  if (value === undefined) return D(1);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw ApiError.badRequest('Multiplier must be a positive, finite number.');
  }
  if (value > POSITION_MAX_MULTIPLIER) {
    throw ApiError.badRequest(`Multiplier may not exceed ${POSITION_MAX_MULTIPLIER}.`);
  }
  return D(value);
}

function normaliseSide(value: string): PositionSideValue {
  const side = value.trim().toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    throw ApiError.badRequest('Side must be BUY or SELL.');
  }
  return side;
}

/* ────────────────────────────────── DTO ──────────────────────────────────── */

function num(value: { toNumber: () => number } | null): number | null {
  return value === null ? null : value.toNumber();
}

function toInternalPositionDTO(row: Position): InternalPositionDTO {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    stake: row.stake.toNumber(),
    multiplier: row.multiplier.toNumber(),
    entryPrice: row.entryPrice.toNumber(),
    currentPrice: row.currentPrice.toNumber(),
    stopLoss: num(row.stopLoss),
    takeProfit: num(row.takeProfit),
    pnl: row.pnl.toNumber(),
    status: row.status,
    executionMode: row.executionMode,
    closePrice: num(row.closePrice),
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  };
}

/* ───────────────────────────────── open ──────────────────────────────────── */

export interface OpenPositionInput {
  userId: string;
  symbol: string;
  side: string;
  stakeUsd: number;
  /** Exposure multiple. Defaults to 1 (spot-like). */
  multiplier?: number;
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  ip?: string | null;
}

/**
 * Open a position, reserving the stake out of withdrawable cash.
 *
 * The user row is locked for the whole read-check-write, exactly like
 * `createInvestment`: two concurrent opens must not each see the same
 * withdrawable balance and reserve it twice.
 */
export async function openPosition(input: OpenPositionInput): Promise<InternalPositionDTO> {
  assertInternalExecution();

  const symbol = normaliseMarketSymbol(input.symbol);
  if (!symbol) throw ApiError.badRequest('Symbol must be a market instrument name.');

  const side = normaliseSide(input.side);
  const stake = assertStake(input.stakeUsd);
  const multiplier = assertMultiplier(input.multiplier);
  const entryPrice = assertPrice(input.entryPrice, 'Entry price');
  const stopLoss = input.stopLoss === null || input.stopLoss === undefined ? null : assertPrice(input.stopLoss, 'Stop loss');
  const takeProfit =
    input.takeProfit === null || input.takeProfit === undefined ? null : assertPrice(input.takeProfit, 'Take profit');

  if (!isProtectivePairSane({ side, entryPrice, stopLoss, takeProfit })) {
    throw ApiError.badRequest(
      side === 'BUY'
        ? 'For a BUY, the stop loss must be below the entry price and the take profit above it.'
        : 'For a SELL, the stop loss must be above the entry price and the take profit below it.',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;

    const snapshot = await getAccountSnapshot(input.userId, tx);
    if (stake.greaterThan(snapshot.withdrawableBalance)) {
      throw ApiError.insufficientFunds(
        `Available balance is $${snapshot.withdrawableBalance.toFixed(2)}; this position needs $${stake.toFixed(2)}. ` +
          'Capital already deployed in strategies or open positions is not available.',
      );
    }

    return tx.position.create({
      data: {
        userId: input.userId,
        symbol,
        side,
        stake: toPrismaDecimal(stake),
        multiplier: toPrismaDecimal(multiplier),
        entryPrice: toPrismaDecimal(entryPrice, 5),
        // The mark starts at the entry price; the first tick moves it.
        currentPrice: toPrismaDecimal(entryPrice, 5),
        stopLoss: stopLoss === null ? null : toPrismaDecimal(stopLoss, 5),
        takeProfit: takeProfit === null ? null : toPrismaDecimal(takeProfit, 5),
        pnl: toPrismaDecimal(0),
        status: 'OPEN',
        executionMode: 'INTERNAL',
      },
    });
  });

  await recordAudit({
    action: AUDIT.POSITION_OPENED,
    userId: input.userId,
    ipAddress: input.ip ?? null,
    details: {
      positionId: created.id,
      symbol,
      side,
      stakeUsd: stake.toNumber(),
      multiplier: multiplier.toNumber(),
      entryPrice: entryPrice.toNumber(),
      stopLoss: stopLoss === null ? null : stopLoss.toNumber(),
      takeProfit: takeProfit === null ? null : takeProfit.toNumber(),
      executionMode: 'INTERNAL',
      ledger: 'STAKE_RESERVED_AS_DEPLOYED_CAPITAL',
    },
  });

  return toInternalPositionDTO(created);
}

/* ───────────────────────────────── list ──────────────────────────────────── */

export interface ListPositionsOptions {
  take?: number;
  cursor?: string | null;
  status?: 'OPEN' | 'CLOSED' | 'CANCELLED' | 'ALL';
}

const POSITION_PAGE_MAX = 100;

export async function listPositions(
  userId: string,
  opts: ListPositionsOptions = {},
): Promise<{ items: InternalPositionDTO[]; nextCursor: string | null }> {
  const take = Math.max(1, Math.min(Math.trunc(opts.take ?? 25), POSITION_PAGE_MAX));
  const status = opts.status ?? 'ALL';

  const rows = await prisma.position.findMany({
    where: { userId, ...(status === 'ALL' ? {} : { status }) },
    orderBy: { openedAt: 'desc' },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toInternalPositionDTO),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/* ───────────────────────────────── close ─────────────────────────────────── */

export interface ClosePositionInput {
  userId: string;
  positionId: string;
  /** Fill price. Supplied by the caller (manual close or the tick engine). */
  price: number;
  reason?: 'MANUAL' | 'STOP_LOSS' | 'TAKE_PROFIT';
  ip?: string | null;
}

/**
 * Close an OPEN position at `price`, freezing its realized P&L.
 *
 * The stake returns to idle cash automatically: the ledger stops counting it as
 * deployed the moment `status` flips to CLOSED. Nothing here moves money by hand.
 */
export async function closePosition(input: ClosePositionInput): Promise<InternalPositionDTO> {
  assertInternalExecution();

  const price = assertPrice(input.price, 'Close price');

  const closed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;

    const row = await tx.position.findFirst({
      where: { id: input.positionId, userId: input.userId },
    });
    if (!row) throw ApiError.notFound('Position not found.');
    if (row.status !== 'OPEN') {
      throw ApiError.conflict(`Only an OPEN position can be closed (current status: ${row.status}).`);
    }

    const pnl = computePositionPnl({
      side: row.side,
      stake: row.stake,
      multiplier: row.multiplier,
      entryPrice: row.entryPrice,
      currentPrice: price,
    });

    // Compare-and-swap: two concurrent closes must not both apply.
    const { count } = await tx.position.updateMany({
      where: { id: row.id, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closePrice: toPrismaDecimal(price, 5),
        currentPrice: toPrismaDecimal(price, 5),
        pnl: toPrismaDecimal(pnl),
        closedAt: new Date(),
      },
    });
    if (count !== 1) {
      throw ApiError.conflict('That position changed state while you were closing it. Reload and check.');
    }

    return tx.position.findUniqueOrThrow({ where: { id: row.id } });
  });

  await recordAudit({
    action: AUDIT.POSITION_CLOSED,
    userId: input.userId,
    ipAddress: input.ip ?? null,
    details: {
      positionId: closed.id,
      symbol: closed.symbol,
      side: closed.side,
      reason: input.reason ?? 'MANUAL',
      stakeUsd: closed.stake.toNumber(),
      entryPrice: closed.entryPrice.toNumber(),
      closePrice: price.toNumber(),
      realizedPnlUsd: usd(closed.pnl).toNumber(),
      ledger: 'PNL_REALIZED_STAKE_RELEASED',
    },
  });

  return toInternalPositionDTO(closed);
}

/* ─────────────────────────────── mark to market ──────────────────────────── */

export interface MarkResult {
  marked: number;
  closed: number;
}

/**
 * Apply a price tick to every OPEN position on `symbol`.
 *
 * Called by the tick engine (the market stream). A position whose stop-loss or
 * take-profit is crossed is CLOSED at the TRIGGER level, not at the tick that
 * crossed it — a gap must not silently hand the client a worse fill than their
 * own protective order promised.
 *
 * Never throws for a single bad row: ticks are high-frequency, and one malformed
 * position must not stall the feed for every other client.
 */
export async function markPositionPrice(symbol: string, price: number): Promise<MarkResult> {
  const normalised = normaliseMarketSymbol(symbol);
  if (!normalised) return { marked: 0, closed: 0 };
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return { marked: 0, closed: 0 };
  }
  const mark = D(price);

  const open = await prisma.position.findMany({
    where: { symbol: normalised, status: 'OPEN' },
  });

  let marked = 0;
  let closed = 0;

  for (const row of open) {
    try {
      const trigger = positionExitTrigger({
        side: row.side,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        price: mark,
      });

      const fill = trigger === 'STOP_LOSS' ? row.stopLoss : trigger === 'TAKE_PROFIT' ? row.takeProfit : mark;
      if (fill === null) continue; // defensive: a trigger always implies a level

      const pnl = computePositionPnl({
        side: row.side,
        stake: row.stake,
        multiplier: row.multiplier,
        entryPrice: row.entryPrice,
        currentPrice: fill,
      });

      const { count } = await prisma.position.updateMany({
        where: { id: row.id, status: 'OPEN' },
        data: {
          currentPrice: toPrismaDecimal(fill, 5),
          pnl: toPrismaDecimal(pnl),
          ...(trigger === null
            ? {}
            : {
                status: 'CLOSED' as const,
                closePrice: toPrismaDecimal(fill, 5),
                closedAt: new Date(),
              }),
        },
      });

      if (count !== 1) continue;

      if (trigger === null) {
        marked += 1;
      } else {
        closed += 1;
        await recordAuditSafe({
          action: AUDIT.POSITION_CLOSED,
          userId: row.userId,
          details: {
            positionId: row.id,
            symbol: row.symbol,
            side: row.side,
            reason: trigger,
            triggerPrice: fill.toNumber(),
            realizedPnlUsd: usd(pnl).toNumber(),
            ledger: 'PNL_REALIZED_STAKE_RELEASED',
          },
        });
      }
    } catch (err) {
      console.error(
        `[positions] could not mark ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { marked, closed };
}

/* ───────────────────────────────── wallet ────────────────────────────────── */

/**
 * The client's wallet, DERIVED from the ledger.
 *
 * There is no `User.balance` column and this function does not create one: it
 * reads the same `getAccountSnapshot` the dashboard, the withdrawal gate and the
 * admin projection use, so the wallet cannot drift from any of them.
 */
export async function getWallet(userId: string): Promise<WalletDTO> {
  const snapshot = await getAccountSnapshot(userId);
  return {
    availableUsd: snapshot.withdrawableBalance.toNumber(),
    deployedUsd: snapshot.activeCapital.toNumber(),
    equityUsd: snapshot.breakdown.equity.toNumber(),
    pendingWithdrawalsUsd: snapshot.pendingWithdrawals.toNumber(),
    netContributedCapitalUsd: snapshot.netContributedCapital.toNumber(),
    openInvestments: snapshot.openInvestments,
    openPositions: snapshot.openPositions,
    formula: snapshot.breakdown.formula,
  };
}
