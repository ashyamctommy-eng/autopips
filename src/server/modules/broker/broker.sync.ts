/**
 * Broker → ledger synchronization.
 *
 * One cycle per connection:
 *   1. account state        → `BrokerConnection` snapshot (balance/equity/freeMargin/status)
 *   2. open positions       → upsert `TradeRecord` rows (only for positions whose
 *                             `inv:<uuid>` comment tag maps to a known investment)
 *   3. deals since watermark → close the matching `TradeRecord` rows with the
 *                             BROKER's exit price / P/L / commission / swap
 *   4. investment roll-up   → realizedPnL = Σ CLOSED.netPnL, unrealizedPnL = Σ OPEN
 *                             position P/L, currentValUsd = capital + realized +
 *                             unrealized − feesDeducted (all in Decimal, in a tx)
 *
 * ZERO-FABRICATION: every P/L figure written here comes from a broker deal or a
 * broker position. A position with no `inv:` tag, an unknown investment, a deal
 * aggregate that the broker did not report, or an unreadable account snapshot all
 * resolve to "write nothing and say so" (the `unattributed` counter, an audit
 * entry, or a skipped update) — never to a substituted number.
 *
 * Positions are matched on the `inv:<uuid>` tag carried in the broker comment
 * (see `metaapi.adapter.ts` for how the tag is written and its length caveat).
 */

import type { BrokerConnection } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { D, toPrismaDecimal, usd, type Numeric } from '@/lib/money';
import { publishActivity, publishEquity } from '@/server/ws/event-bus';
import { AUDIT, recordAudit, recordAuditSafe } from '../audit/audit.service';
import { extractInvestmentIdTag, type PositionClosure } from './metaapi.adapter';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  investmentRooms,
  makeActivity,
  updateBrokerSnapshot,
} from './broker.registry';
import type { BrokerAdapter, BrokerPosition } from './broker.types';

/** Redis watermark: the newest deal timestamp this connection has processed. */
function dealWatermarkKey(metaApiAccountId: string): string {
  return rkey('broker-deal-watermark', metaApiAccountId);
}

/** Redis counter of consecutive failed sync cycles (drives the ERROR state). */
function syncFailuresKey(metaApiAccountId: string): string {
  return rkey('broker-sync-failures', metaApiAccountId);
}

/**
 * First-run look-back window. Operational config, not a trade value: with no
 * watermark yet we ask the broker for the last 24h of deals.
 */
const DEFAULT_DEAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** A connection is only flagged ERROR after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SyncSummary {
  /** Broker-reported open positions seen this cycle. */
  positions: number;
  /** History deals returned by the broker for the watermark window. */
  deals: number;
  /** Positions (or deals) that could not be tied to a known investment. */
  unattributed: number;
  /** Non-fatal problems (skipped rows, unreadable aggregates). */
  errors: number;
  /** Investments whose roll-up was rewritten this cycle. */
  investmentsUpdated: number;
}

// ------------------------------------------------------- adapter capabilities

/**
 * Optional adapter capability: the complete closing-deal aggregate of a position.
 * Implemented by `MetaApiBrokerAdapter`; other adapters may offer it later.
 */
export interface PositionClosureCapable {
  getPositionClosure(positionId: string): Promise<PositionClosure | null>;
}

export function supportsPositionClosure(
  adapter: BrokerAdapter,
): adapter is BrokerAdapter & PositionClosureCapable {
  return typeof (adapter as { getPositionClosure?: unknown }).getPositionClosure === 'function';
}

// ----------------------------------------------------------------- watermarks

async function readWatermark(metaApiAccountId: string): Promise<Date> {
  const stored = await redis.get(dealWatermarkKey(metaApiAccountId));
  if (stored) {
    const parsed = new Date(stored);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() - DEFAULT_DEAL_LOOKBACK_MS);
}

async function writeWatermark(metaApiAccountId: string, at: Date): Promise<void> {
  await redis.set(dealWatermarkKey(metaApiAccountId), at.toISOString());
}

// ----------------------------------------------------------------- roll-ups

export interface InvestmentRollup {
  investmentId: string;
  userId: string;
  capitalUsd: Numeric;
  realizedPnL: Numeric;
  unrealizedPnL: Numeric;
  feesDeducted: Numeric;
  currentValUsd: Numeric;
}

/**
 * Rewrites one investment from its own ledger rows.
 *
 *   realizedPnL   = Σ TradeRecord.netPnL where status = CLOSED   (broker deals)
 *   unrealizedPnL = Σ broker unrealized P/L of the investment's OPEN positions
 *   currentValUsd = capitalUsd + realizedPnL + unrealizedPnL − feesDeducted
 *
 * Runs in a Prisma transaction and publishes the resulting equity snapshot to the
 * owner's socket room. Returns null when the investment no longer exists.
 */
export async function recomputeInvestment(
  investmentId: string,
  unrealizedPnLInput: Numeric,
): Promise<InvestmentRollup | null> {
  const rollup = await prisma.$transaction(async (tx) => {
    const investment = await tx.investment.findUnique({ where: { id: investmentId } });
    if (!investment) return null;

    const closed = await tx.tradeRecord.aggregate({
      where: { investmentId, status: 'CLOSED' },
      _sum: { netPnL: true },
    });

    const capital = usd(investment.capitalUsd);
    const realized = usd(closed._sum.netPnL ?? 0);
    const unrealized = usd(unrealizedPnLInput);
    const fees = usd(investment.feesDeducted);
    const currentVal = usd(capital.plus(realized).plus(unrealized).minus(fees));

    await tx.investment.update({
      where: { id: investmentId },
      data: {
        realizedPnL: toPrismaDecimal(realized),
        unrealizedPnL: toPrismaDecimal(unrealized),
        currentValUsd: toPrismaDecimal(currentVal),
      },
    });

    return {
      investmentId,
      userId: investment.userId,
      capitalUsd: capital.toNumber(),
      realizedPnL: realized.toNumber(),
      unrealizedPnL: unrealized.toNumber(),
      feesDeducted: fees.toNumber(),
      currentValUsd: currentVal.toNumber(),
    } satisfies InvestmentRollup;
  });

  if (!rollup) return null;

  await publishEquity(rollup.userId, {
    scope: 'investment',
    investmentId: rollup.investmentId,
    capitalUsd: rollup.capitalUsd,
    realizedPnL: rollup.realizedPnL,
    unrealizedPnL: rollup.unrealizedPnL,
    feesDeducted: rollup.feesDeducted,
    currentValUsd: rollup.currentValUsd,
    at: new Date().toISOString(),
  });

  return rollup;
}

// ------------------------------------------------------------------- position rows

/**
 * Creates/refreshes the OPEN `TradeRecord` for a broker position. Refuses to touch
 * a row that is already CLOSED (a re-used broker position id must not resurrect a
 * booked result), and refuses to re-attribute a row to another investment.
 */
async function upsertOpenTradeRecord(
  connectionId: string,
  investmentId: string,
  position: BrokerPosition,
): Promise<boolean> {
  const existing = await prisma.tradeRecord.findUnique({
    where: {
      brokerId_metaApiPositionId: { brokerId: connectionId, metaApiPositionId: position.positionId },
    },
  });

  if (!existing) {
    await prisma.tradeRecord.create({
      data: {
        investmentId,
        brokerId: connectionId,
        metaApiPositionId: position.positionId,
        instrument: position.instrument,
        direction: position.direction,
        volume: toPrismaDecimal(position.volume, 5),
        entryPrice: toPrismaDecimal(position.entryPrice, 5),
        stopLoss: position.stopLoss === null ? null : toPrismaDecimal(position.stopLoss, 5),
        takeProfit: position.takeProfit === null ? null : toPrismaDecimal(position.takeProfit, 5),
        // Broker-reported costs only; P/L columns stay at their schema defaults
        // until a broker deal reports them (no invented zero "result").
        commission: toPrismaDecimal(position.commission),
        swap: toPrismaDecimal(position.swap),
        status: 'OPEN',
        openedAt: position.openedAt,
      },
    });
    return true;
  }

  if (existing.status !== 'OPEN') {
    console.warn(
      `[broker.sync] position ${position.positionId} is open at the broker but trade ${existing.id} is ${existing.status}; leaving the booked row untouched.`,
    );
    return false;
  }
  if (existing.investmentId !== investmentId) {
    console.warn(
      `[broker.sync] position ${position.positionId} is tagged inv:${investmentId} but trade ${existing.id} belongs to investment ${existing.investmentId}; not re-attributing.`,
    );
    return false;
  }

  await prisma.tradeRecord.update({
    where: { id: existing.id },
    data: {
      volume: toPrismaDecimal(position.volume, 5),
      stopLoss: position.stopLoss === null ? null : toPrismaDecimal(position.stopLoss, 5),
      takeProfit: position.takeProfit === null ? null : toPrismaDecimal(position.takeProfit, 5),
      commission: toPrismaDecimal(position.commission),
      swap: toPrismaDecimal(position.swap),
      // The broker's own open time replaces the placeholder written at fill time.
      openedAt: position.openedAt,
      status: 'OPEN',
    },
  });
  return true;
}

/**
 * Applies a complete broker closure to the OPEN `TradeRecord` of that position.
 * Returns the investment id that was closed, or null when there was nothing to
 * close (no row / already closed / broker reported no closing deal).
 */
export async function applyPositionClosure(
  connectionId: string,
  closure: PositionClosure,
): Promise<{ investmentId: string; tradeId: string; netPnL: number } | null> {
  if (closure.closedAt === null || closure.exitPrice === null) {
    // Without a broker date and price there is no honest way to close the row.
    console.warn(
      `[broker.sync] closing deals for position ${closure.positionId} lack a price/time; trade left OPEN.`,
    );
    return null;
  }

  const trade = await prisma.tradeRecord.findUnique({
    where: {
      brokerId_metaApiPositionId: { brokerId: connectionId, metaApiPositionId: closure.positionId },
    },
  });
  if (!trade || trade.status !== 'OPEN') return null;

  // SECOND GUARD: the broker's closing deals must cover the whole booked volume.
  // A partial close produces DEAL_ENTRY_OUT deals too, and booking those as the
  // position's final result would understate the client's P/L.
  if (closure.closingVolume === null || D(closure.closingVolume).plus('0.00001').lessThan(D(trade.volume))) {
    console.warn(
      `[broker.sync] closing deals for position ${closure.positionId} cover ${closure.closingVolume ?? 'unknown'} of ${D(trade.volume).toString()} lots; trade left OPEN.`,
    );
    return null;
  }

  const gross = usd(closure.grossPnL);
  const commission = usd(closure.commission);
  const swap = usd(closure.swap);
  const net = usd(closure.netPnL);

  await prisma.tradeRecord.update({
    where: { id: trade.id },
    data: {
      exitPrice: toPrismaDecimal(closure.exitPrice, 5),
      grossPnL: toPrismaDecimal(gross),
      commission: toPrismaDecimal(commission),
      swap: toPrismaDecimal(swap),
      netPnL: toPrismaDecimal(net),
      status: 'CLOSED',
      closedAt: closure.closedAt,
    },
  });

  await recordAudit({
    action: AUDIT.METAAPI_POSITION_CLOSED,
    userId: null,
    details: {
      brokerConnectionId: connectionId,
      investmentId: trade.investmentId,
      tradeId: trade.id,
      metaApiPositionId: closure.positionId,
      dealIds: closure.dealIds,
      exitPrice: closure.exitPrice,
      closingVolume: closure.closingVolume,
      grossPnL: gross.toNumber(),
      commission: commission.toNumber(),
      swap: swap.toNumber(),
      netPnL: net.toNumber(),
      closedAt: closure.closedAt.toISOString(),
    },
  });

  return { investmentId: trade.investmentId, tradeId: trade.id, netPnL: net.toNumber() };
}

// ------------------------------------------------------------------ main cycle

/**
 * Synchronizes one connection. Throws only for connection-level failures —
 * individual rows are skipped (and counted) instead.
 */
export async function syncBrokerConnection(conn: BrokerConnection): Promise<SyncSummary> {
  const summary: SyncSummary = {
    positions: 0,
    deals: 0,
    unattributed: 0,
    errors: 0,
    investmentsUpdated: 0,
  };

  const adapter = await ensureBrokerConnected(await getAdapterForConnection(conn));

  // 1. account snapshot ------------------------------------------------------
  const state = await adapter.getAccountState();
  await updateBrokerSnapshot(conn.id, state);

  // 2. open positions --------------------------------------------------------
  const positions = await adapter.getOpenPositions();
  summary.positions = positions.length;

  const byInvestment = new Map<string, BrokerPosition[]>();
  const unrealizedByInvestment = new Map<string, number>();
  for (const position of positions) {
    const tag = position.investmentId ?? extractInvestmentIdTag(position.comment);
    if (!tag) {
      summary.unattributed += 1;
      continue;
    }
    const list = byInvestment.get(tag);
    if (list) list.push(position);
    else byInvestment.set(tag, [position]);
    unrealizedByInvestment.set(
      tag,
      D(unrealizedByInvestment.get(tag) ?? 0).plus(position.unrealizedPnL).toNumber(),
    );
  }

  if (byInvestment.size > 0) {
    const known = await prisma.investment.findMany({
      where: { id: { in: [...byInvestment.keys()] } },
      select: { id: true },
    });
    const knownIds = new Set(known.map((row) => row.id));
    for (const [investmentId, list] of byInvestment) {
      if (!knownIds.has(investmentId)) {
        // The tag points at an investment we do not have: report, never guess.
        summary.unattributed += list.length;
        byInvestment.delete(investmentId);
        unrealizedByInvestment.delete(investmentId);
      }
    }
  }

  for (const [investmentId, list] of byInvestment) {
    for (const position of list) {
      try {
        const ok = await upsertOpenTradeRecord(conn.id, investmentId, position);
        if (!ok) summary.errors += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(
          `[broker.sync] failed to upsert position ${position.positionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 3. deals since the watermark --------------------------------------------
  const watermark = await readWatermark(conn.metaApiAccountId);
  const deals = await adapter.getDealsSince(watermark);
  summary.deals = deals.length;

  const openPositionIds = new Set(positions.map((position) => position.positionId));

  // Close candidates: positions the broker just reported deals for, plus any OPEN
  // row whose position is no longer open at the broker (catches a missed window).
  const openRows = await prisma.tradeRecord.findMany({
    where: { brokerId: conn.id, status: 'OPEN' },
    select: { id: true, investmentId: true, metaApiPositionId: true },
  });
  const candidates = new Set<string>();
  for (const deal of deals) {
    if (openPositionIds.has(deal.positionId)) continue; // still open → partial close
    candidates.add(deal.positionId);
  }
  for (const row of openRows) {
    if (row.metaApiPositionId && !openPositionIds.has(row.metaApiPositionId)) {
      candidates.add(row.metaApiPositionId);
    }
  }

  const closedInvestmentIds = new Set<string>();
  if (candidates.size > 0) {
    if (!supportsPositionClosure(adapter)) {
      summary.errors += 1;
      console.warn('[broker.sync] adapter cannot report position closures; skipping deal closures.');
    } else {
      for (const positionId of candidates) {
        const investmentId = openRows.find((row) => row.metaApiPositionId === positionId)?.investmentId;
        if (!investmentId) {
          summary.unattributed += 1;
          continue;
        }
        try {
          const closure = await adapter.getPositionClosure(positionId);
          if (!closure) {
            summary.errors += 1;
            console.warn(`[broker.sync] no closing deal reported for position ${positionId}; trade left OPEN.`);
            continue;
          }
          const applied = await applyPositionClosure(conn.id, closure);
          if (applied) closedInvestmentIds.add(applied.investmentId);
        } catch (err) {
          summary.errors += 1;
          console.error(
            `[broker.sync] closure of position ${positionId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  // 4. investment roll-ups ---------------------------------------------------
  const touched = new Set<string>([...byInvestment.keys(), ...closedInvestmentIds]);
  for (const investmentId of touched) {
    // An investment with no open position left sums to 0 — the sum of an empty
    // set, not a substituted number.
    const unrealized = unrealizedByInvestment.get(investmentId) ?? 0;
    const rollup = await recomputeInvestment(investmentId, unrealized);
    if (rollup) summary.investmentsUpdated += 1;
  }

  // 5. watermark -------------------------------------------------------------
  if (deals.length > 0) {
    const newest = deals.reduce(
      (acc, deal) => (deal.executedAt.getTime() > acc.getTime() ? deal.executedAt : acc),
      watermark,
    );
    await writeWatermark(conn.metaApiAccountId, newest);
  }

  return summary;
}

/**
 * Sync cycle over every non-ERROR connection. Safe on an interval: one bad
 * connection is isolated, counted, audited (`BROKER_ERROR`) and — after
 * `MAX_CONSECUTIVE_FAILURES` consecutive failures — flagged ERROR so it stops
 * burning API quota until an admin re-adds or fixes it.
 */
export async function runSyncCycle(): Promise<{
  connections: number;
  summaries: Array<{ connectionId: string; summary?: SyncSummary; error?: string }>;
}> {
  const connections = await prisma.brokerConnection.findMany({
    where: { status: { not: 'ERROR' } },
    orderBy: { updatedAt: 'asc' },
  });

  const results: Array<{ connectionId: string; summary?: SyncSummary; error?: string }> = [];

  for (const conn of connections) {
    try {
      const summary = await syncBrokerConnection(conn);
      await redis.del(syncFailuresKey(conn.metaApiAccountId));
      results.push({ connectionId: conn.id, summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failures = await redis.incr(syncFailuresKey(conn.metaApiAccountId));
      results.push({ connectionId: conn.id, error: message });

      await recordAuditSafe({
        action: AUDIT.BROKER_ERROR,
        details: {
          brokerConnectionId: conn.id,
          metaApiAccountId: conn.metaApiAccountId,
          maskedAccount: conn.maskedAccount,
          consecutiveFailures: failures,
          error: message,
        },
      });
      await publishActivity(
        makeActivity(
          'BROKER_SYNC_FAILED',
          `Broker sync failed for ${conn.maskedAccount}: ${message}`,
          failures >= MAX_CONSECUTIVE_FAILURES ? 'error' : 'warning',
          { brokerConnectionId: conn.id, consecutiveFailures: failures },
          investmentRooms(null),
        ),
      );

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        await prisma.brokerConnection.update({
          where: { id: conn.id },
          data: { status: 'ERROR', updatedAt: new Date() },
        });
        await recordAuditSafe({
          action: AUDIT.BROKER_ERROR,
          details: {
            brokerConnectionId: conn.id,
            metaApiAccountId: conn.metaApiAccountId,
            state: 'ERROR',
            consecutiveFailures: failures,
            note: 'Connection flagged ERROR after repeated failures; excluded from further sync cycles until an admin re-adds it.',
          },
        });
      }
    }
  }

  return { connections: connections.length, summaries: results };
}
