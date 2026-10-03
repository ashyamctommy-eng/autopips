/**
 * Broker → ledger synchronization.
 *
 * One cycle per connection:
 *   1. account state        → `BrokerConnection` snapshot (balance/equity/freeMargin/status)
 *   2. open positions       → upsert `TradeRecord` rows (attributed through the
 *                             contract-id map written at fill time — see
 *                             `resolvePositionInvestment`)
 *   3. deals since watermark → close the matching `TradeRecord` rows with the
 *                             BROKER's exit price / P/L / commission / swap
 *   4. investment roll-up   → realizedPnL = Σ CLOSED.netPnL, unrealizedPnL = Σ OPEN
 *                             position P/L, currentValUsd = capital + realized +
 *                             unrealized − feesDeducted (all in Decimal, in a tx)
 *
 * ZERO-FABRICATION: every P/L figure written here comes from a broker deal or a
 * broker position. A position that cannot be attributed, a deal aggregate the
 * broker did not report, or an unreadable account snapshot all resolve to "write
 * nothing and say so" (the `unattributed` counter, an audit entry, or a skipped
 * update) — never to a substituted number.
 *
 * ATTRIBUTION: `sig:<signalId>:inv:<investmentId>` client order ids are never
 * sent to Deriv, and a Deriv contract has no comment field to read back — so for
 * a contract broker the ONLY end-to-end key is this platform's own record of the
 * fill (`order.manager` writes `TradeRecord { brokerId, derivContractId,
 * investmentId }`, unique on `@@unique([brokerId, derivContractId])`). That
 * contract-id map is the primary lookup; the `inv:<uuid>` comment tag remains as
 * a fallback for a lot-denominated bridge that still stamps one. A position that
 * resolves to neither stays UNATTRIBUTED and is reported, never guessed into an
 * account.
 */

import type { BrokerConnection } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { D, toPrismaDecimal, usd, type Numeric } from '@/lib/money';
import { publishActivity, publishEquity } from '@/server/ws/event-bus';
import { AUDIT, recordAudit, recordAuditSafe } from '../audit/audit.service';
import type { PositionClosure } from './broker.types';

/**
 * Investment tag found in a broker position comment (`inv:<uuid>`).
 *
 * An MT4/MT5 bridge let the platform stamp the investment id into the order
 * comment and read it back on the position. Deriv contracts have no comment
 * field, so for a contract broker this returns null and the position is
 * attributable only through this platform's own fill records — see
 * `resolvePositionInvestment` for the resolution order.
 */
const INVESTMENT_TAG_RE = /inv:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function extractInvestmentIdTag(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = INVESTMENT_TAG_RE.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  investmentRooms,
  makeActivity,
  updateBrokerSnapshot,
} from './broker.registry';
import type { BrokerAdapter, BrokerPosition } from './broker.types';

/** Redis watermark: the newest deal timestamp this connection has processed. */
function dealWatermarkKey(derivAccountId: string): string {
  return rkey('broker-deal-watermark', derivAccountId);
}

/** Redis counter of consecutive failed sync cycles (drives the ERROR state). */
function syncFailuresKey(derivAccountId: string): string {
  return rkey('broker-sync-failures', derivAccountId);
}

/**
 * First-run look-back window. Operational config, not a trade value: with no
 * watermark yet we ask the broker for the last 24h of deals.
 */
const DEFAULT_DEAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * OVERLAP re-read when querying deals (`date_from = watermark − OVERLAP`).
 *
 * The watermark is a CURSOR, not a source of truth: it records the newest deal
 * timestamp already processed, and the broker's `profit_table` is filtered on
 * `date_from`. A deal's executedAt is the SETTLEMENT time for a sold contract
 * (see `deriv.adapter.getDealsSince`), which can be materially later than the
 * time the contract was opened — and a contract that settles just after a sync
 * cycle would otherwise fall entirely outside the next window and never be
 * booked, leaving its P/L unposted forever.
 *
 * Six hours is chosen to cover a long-dated contract settling on the following
 * session while keeping the re-read bounded: re-processing a deal is harmless
 * (the closure write is atomic and idempotent — see `applyPositionClosure`), so
 * the cost of the overlap is a handful of repeated `proposal_open_contract`
 * reads per cycle, not a duplicated booking.
 */
const DEAL_WINDOW_OVERLAP_MS = 6 * 60 * 60 * 1000;

/** A connection is only flagged ERROR after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SyncSummary {
  /** Broker-reported open positions seen this cycle. */
  positions: number;
  /** History deals returned by the broker for the watermark window. */
  deals: number;
  /** Positions (or deals) that could not be tied to a known investment. */
  unattributed: number;
  /**
   * The contract ids behind `unattributed`, so an operator can act on them.
   * A position opened outside the platform stays visibly unattributed rather
   * than being guessed into somebody's account — these ids are the worklist.
   */
  unattributedContractIds: string[];
  /** Non-fatal problems (skipped rows, unreadable aggregates). */
  errors: number;
  /** Investments whose roll-up was rewritten this cycle. */
  investmentsUpdated: number;
}

// ------------------------------------------------------- adapter capabilities

/**
 * Optional adapter capability: the complete closing-deal aggregate of a position.
 * Implemented by the broker adapter when the broker reports closure detail.
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

async function readWatermark(derivAccountId: string): Promise<Date> {
  const stored = await redis.get(dealWatermarkKey(derivAccountId));
  if (stored) {
    const parsed = new Date(stored);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() - DEFAULT_DEAL_LOOKBACK_MS);
}

async function writeWatermark(derivAccountId: string, at: Date): Promise<void> {
  await redis.set(dealWatermarkKey(derivAccountId), at.toISOString());
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

/** Where a position's investment id came from. `null` = unattributed. */
export type PositionAttributionSource = 'trade-record' | 'position' | 'comment';

export interface PositionAttribution {
  investmentId: string | null;
  source: PositionAttributionSource | null;
}

/**
 * Ties one broker position to a platform investment. The order is fixed:
 *
 *   1. `trade-record` — this platform's own contract-id map, written at FILL time
 *      (`order.manager` → `TradeRecord { brokerId, derivContractId, investmentId }`,
 *      unique on `@@unique([brokerId, derivContractId])`). This is the only key
 *      that survives the whole round trip for a contract broker: the
 *      `sig:<signalId>:inv:<investmentId>` client order id is never sent to
 *      Deriv, and a Deriv contract carries no comment to read back.
 *   2. `position` / `comment` — the legacy lot-denominated bridge tags, kept so a
 *      bridge that DOES stamp `inv:<uuid>` keeps working unchanged.
 *   3. `null` — no record, no tag. The position stays UNATTRIBUTED.
 *
 * A position opened outside the platform MUST land in case 3 and be reported; it
 * is never assigned to a client by proximity, timing or size.
 *
 * Exported so the reconciliation report (`broker.reconcile.ts`) resolves
 * attribution through exactly this function: a drift report that attributed
 * differently from the sync would flag its own bug as broker drift.
 */
export async function resolvePositionInvestment(
  brokerConnectionId: string,
  position: BrokerPosition,
): Promise<PositionAttribution> {
  const booked = await prisma.tradeRecord.findUnique({
    where: {
      brokerId_derivContractId: {
        brokerId: brokerConnectionId,
        derivContractId: position.positionId,
      },
    },
    select: { investmentId: true },
  });
  if (booked) return { investmentId: booked.investmentId, source: 'trade-record' };

  if (position.investmentId) return { investmentId: position.investmentId, source: 'position' };

  const tagged = extractInvestmentIdTag(position.comment);
  if (tagged) return { investmentId: tagged, source: 'comment' };

  return { investmentId: null, source: null };
}

/** What a position's size means to `TradeRecord.volume` / `.notional`. */
export interface BookedPositionSize {
  /** Lots, or the STAKE for a stake-denominated broker. See the schema comment. */
  volume: Numeric;
  /** Broker-defined exposure in USD, when the position defines one. */
  notional: Numeric | null;
}

/**
 * Size of a broker position in the ledger's terms, or null when the broker
 * reported no size at all.
 *
 * `volume = position.volume ?? position.stakeUsd`. That is NOT a fabrication:
 * the schema defines `TradeRecord.volume` as "lots for a lot-denominated broker;
 * for a STAKE-denominated broker (Deriv multipliers) this is the STAKE", and
 * `stakeUsd` is the broker's own buy price for the contract. Writing 0 (the old
 * behaviour's alternative) would understate exposure to nothing; refusing to book
 * — the old behaviour — dropped every Deriv position on the floor.
 *
 * `notional = stakeUsd × multiplier`, which is the broker's own exposure
 * convention for a multiplier contract and the same figure the adapter reports on
 * fill (`PlaceOrderResult.notional`). It is deliberately NOT `volume × entryPrice`
 * — that is right for lots and wrong by a factor of the price for a stake (a $100
 * stake on gold at 4270 would read as $427,000). A lot broker reports no
 * multiplier, so this is null there and the ledger's documented fallback
 * (volume × entryPrice) applies, which is exactly correct for lots.
 */
export function resolvePositionSize(position: BrokerPosition): BookedPositionSize | null {
  const volume: Numeric | null = position.volume ?? position.stakeUsd;
  if (volume === null) return null;

  const notional: Numeric | null =
    position.stakeUsd !== null && position.multiplier !== null
      ? D(position.stakeUsd).times(position.multiplier)
      : null;

  return { volume, notional };
}

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
  // Both denominations are booked through `volume`/`notional` — see
  // `resolvePositionSize`. Only a position that reports NEITHER a lot size NOR a
  // stake has no size at all, and that one is refused (and counted) rather than
  // written as a zero.
  const size = resolvePositionSize(position);
  if (size === null) {
    console.warn(
      `[broker.sync] position ${position.positionId} (${position.instrument}) reports neither a lot size nor a stake — no size to book; trade not written.`,
    );
    return false;
  }

  const volume = toPrismaDecimal(size.volume, 5);
  const notional = size.notional === null ? null : toPrismaDecimal(size.notional, 2);

  const existing = await prisma.tradeRecord.findUnique({
    where: {
      brokerId_derivContractId: { brokerId: connectionId, derivContractId: position.positionId },
    },
  });

  if (!existing) {
    await prisma.tradeRecord.create({
      data: {
        investmentId,
        brokerId: connectionId,
        derivContractId: position.positionId,
        instrument: position.instrument,
        direction: position.direction,
        volume,
        notional,
        entryPrice: toPrismaDecimal(position.entryPrice, 5),
        stopLoss: position.stopLoss === null ? null : toPrismaDecimal(position.stopLoss, 5),
        takeProfit: position.takeProfit === null ? null : toPrismaDecimal(position.takeProfit, 5),
        // Broker-reported costs only; P/L columns stay at their schema defaults
        // until a broker deal reports them (no invented zero "result").
        ...(position.commission === null ? {} : { commission: toPrismaDecimal(position.commission) }),
        ...(position.swap === null ? {} : { swap: toPrismaDecimal(position.swap) }),
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
      volume,
      // The UPDATE path writes `notional` too. Leaving it out was a real bug:
      // `getOpenExposure` falls back to `volume × entryPrice` when notional is
      // null, which is correct for lots and overstates a stake by the price. It
      // is only omitted when the position reports no multiplier — and then the
      // figure the fill path already wrote is the broker's own and must NOT be
      // erased.
      ...(notional === null ? {} : { notional }),
      stopLoss: position.stopLoss === null ? null : toPrismaDecimal(position.stopLoss, 5),
      takeProfit: position.takeProfit === null ? null : toPrismaDecimal(position.takeProfit, 5),
      ...(position.commission === null ? {} : { commission: toPrismaDecimal(position.commission) }),
      ...(position.swap === null ? {} : { swap: toPrismaDecimal(position.swap) }),
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
      brokerId_derivContractId: { brokerId: connectionId, derivContractId: closure.positionId },
    },
  });
  if (!trade || trade.status !== 'OPEN') return null;

  // CLOSURE ACCEPTANCE — the position is fully closed when the broker PROVED it:
  //
  //   (a) `closure.fullyClosed` — the adapter's settlement proof (Deriv: the
  //       contract reports `is_sold` / `status === 'sold'`). A contract broker
  //       settles all-or-nothing and reports NO closing lot size, so this flag is
  //       the only honest proof available for Deriv. Requiring a closing volume
  //       instead is why every contract closure used to be refused and no
  //       realized P/L was ever written.
  //   (b) the lot brokers' volume-coverage rule: the closing deals cover the whole
  //       booked volume. This stays in force, so a partial close still refuses —
  //       booking the partial deals as the position's final result would
  //       understate the client's P/L.
  const coveredByClosingVolume =
    closure.closingVolume !== null &&
    !D(closure.closingVolume).plus('0.00001').lessThan(D(trade.volume));

  if (!closure.fullyClosed && !coveredByClosingVolume) {
    console.warn(
      `[broker.sync] closing deals for position ${closure.positionId} cover ${closure.closingVolume ?? 'unknown'} of ${D(trade.volume).toString()} and full settlement was not reported; trade left OPEN.`,
    );
    return null;
  }

  // Deriv publishes one net profit for a settled contract; it itemises no gross
  // figure, commission or swap. Those stay absent (the columns keep their schema
  // default) rather than being written as a zero the broker never reported.
  const gross = closure.grossPnL === null ? null : usd(closure.grossPnL);
  const commission = closure.commission === null ? null : usd(closure.commission);
  const swap = closure.swap === null ? null : usd(closure.swap);
  const net = usd(closure.netPnL);

  // ATOMIC CLOSE. The read above and this write are separate statements, and the
  // same position can be closed concurrently by the sync cycle and by the manual
  // `closePositionForInvestment` / admin force-close paths. Both would otherwise
  // see `status: 'OPEN'` and both would update by id, so the second would
  // overwrite the first's figures and emit a second close audit row. The `status`
  // predicate makes the transition the compare-and-swap: exactly one writer can
  // observe `count === 1`.
  const applied = await prisma.tradeRecord.updateMany({
    where: { id: trade.id, status: 'OPEN' },
    data: {
      exitPrice: toPrismaDecimal(closure.exitPrice, 5),
      ...(gross === null ? {} : { grossPnL: toPrismaDecimal(gross) }),
      ...(commission === null ? {} : { commission: toPrismaDecimal(commission) }),
      ...(swap === null ? {} : { swap: toPrismaDecimal(swap) }),
      netPnL: toPrismaDecimal(net),
      status: 'CLOSED',
      closedAt: closure.closedAt,
    },
  });

  if (applied.count !== 1) {
    // Another closer won the race after our read. It has already written the
    // result and its own audit row; this call is a silent no-op that reports
    // "already closed" (null), never a second audit row and never an overwrite.
    console.warn(
      `[broker.sync] position ${closure.positionId} was closed by another writer before this update; no-op.`,
    );
    return null;
  }

  await recordAudit({
    action: AUDIT.BROKER_POSITION_CLOSED,
    userId: null,
    details: {
      brokerConnectionId: connectionId,
      investmentId: trade.investmentId,
      tradeId: trade.id,
      derivContractId: closure.positionId,
      dealIds: closure.dealIds,
      exitPrice: closure.exitPrice,
      closingVolume: closure.closingVolume,
      grossPnL: gross === null ? null : gross.toNumber(),
      commission: commission === null ? null : commission.toNumber(),
      swap: swap === null ? null : swap.toNumber(),
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
    unattributedContractIds: [],
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
    // ATTRIBUTION ORDER (see resolvePositionInvestment): the contract-id map
    // written at fill time first, then the legacy lot-bridge tags, then
    // UNATTRIBUTED. A position opened outside the platform is never guessed into
    // an account — it is counted and its contract id surfaced to the operator.
    const attribution = await resolvePositionInvestment(conn.id, position);
    if (attribution.investmentId === null) {
      summary.unattributed += 1;
      summary.unattributedContractIds.push(position.positionId);
      continue;
    }
    const tag = attribution.investmentId;
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
        for (const position of list) summary.unattributedContractIds.push(position.positionId);
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
  const watermark = await readWatermark(conn.derivAccountId);
  // The watermark is a CURSOR (the newest deal already processed), not a source
  // of truth about when a deal happened. Overlap the query backwards by
  // DEAL_WINDOW_OVERLAP_MS so a contract that settled after its purchase/open
  // time is still inside the window; re-processing a caught deal is harmless
  // because the closure write is atomic and idempotent (see applyPositionClosure).
  const deals = await adapter.getDealsSince(new Date(watermark.getTime() - DEAL_WINDOW_OVERLAP_MS));
  summary.deals = deals.length;

  const openPositionIds = new Set(positions.map((position) => position.positionId));

  // Close candidates: OPEN rows at the LEDGER whose contract is no longer open
  // at the broker. The set is built from the LEDGER side rather than from the
  // deal list, because the deal window now overlaps the watermark (see
  // DEAL_WINDOW_OVERLAP_MS): a settled contract reappears in the broker's
  // history for the length of the overlap, and a deal for a contract this
  // platform never booked (or already settled) has no row to close. Treating each
  // reappearance as a position would drown the genuinely unattributed ones
  // reported in step 2 — and `applyPositionClosure` is a no-op on a CLOSED row
  // anyway, so the deal list adds nothing here.
  const openRows = await prisma.tradeRecord.findMany({
    where: { brokerId: conn.id, status: 'OPEN' },
    select: { id: true, investmentId: true, derivContractId: true },
  });
  const candidates = new Set<string>();
  for (const row of openRows) {
    // Not open at the broker right now → either the broker says it settled, or a
    // settlement was missed in an earlier window. Both are worth a closure read.
    if (row.derivContractId && !openPositionIds.has(row.derivContractId)) {
      candidates.add(row.derivContractId);
    }
  }

  const closedInvestmentIds = new Set<string>();
  if (candidates.size > 0) {
    if (!supportsPositionClosure(adapter)) {
      summary.errors += 1;
      console.warn('[broker.sync] adapter cannot report position closures; skipping deal closures.');
    } else {
      for (const positionId of candidates) {
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
    await writeWatermark(conn.derivAccountId, newest);
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
      await redis.del(syncFailuresKey(conn.derivAccountId));
      results.push({ connectionId: conn.id, summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failures = await redis.incr(syncFailuresKey(conn.derivAccountId));
      results.push({ connectionId: conn.id, error: message });

      await recordAuditSafe({
        action: AUDIT.BROKER_ERROR,
        details: {
          brokerConnectionId: conn.id,
          derivAccountId: conn.derivAccountId,
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
            derivAccountId: conn.derivAccountId,
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
