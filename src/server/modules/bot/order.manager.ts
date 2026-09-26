/**
 * Order manager — the signal execution pipeline.
 *
 *   signal → broker connection → live account state → RISK GATE → lot allocation
 *          → broker order (per investment) → TradeRecord + audit + activity
 *
 * Invariants:
 *  - The risk gate is evaluated BEFORE any allocation or order; a rejection records
 *    `RISK_CHECK_FAILED` and publishes an activity, and never touches the broker.
 *  - A `TradeRecord` is only ever created from a broker-confirmed fill; a rejected
 *    order produces an audit entry and nothing else (no fabricated P/L, ever).
 *  - Every order carries a deterministic `clientOrderId` (`sig:<signalId>:inv:<investmentId>`)
 *    which is passed to the broker as the position comment, so a position can be
 *    traced back to the investment that funded it (and a retry cannot double-open).
 *  - Nothing throws for a broker rejection: brokers say no all the time, and that is
 *    a normal, audited outcome.
 */

import type { BrokerConnection } from '@prisma/client';
import { WS_EVENTS } from '@/lib/contracts';
import { serverEnv } from '@/lib/env';
import { ApiError } from '@/lib/http';
import { D, toPrismaDecimal, usd } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { claimOnceDurable, releaseClaimDurable } from '@/lib/idempotency';
import { publishActivity, publishTradeEvent } from '@/server/ws/event-bus';
import { AUDIT, AUDIT_PAYOUT, recordAudit, recordAuditSafe } from '../audit/audit.service';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  investmentRooms,
  makeActivity,
} from '../broker/broker.registry';
import { applyPositionClosure, recomputeInvestment, supportsPositionClosure } from '../broker/broker.sync';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerPosition,
  PlaceOrderRequest,
  SymbolSpec,
} from '../broker/broker.types';
import { getSettingNumber } from '@/server/modules/settings/settings.service';
import { checkTradingAllowed } from './bot-control.service';
import { allocateAcrossInvestments, MASTER_TO_CLIENT_FORMULA } from './lot.allocator';
import { evaluatePreTradeRisk, type RiskContextWithFloor } from './risk.engine';
import { allocateStake } from './stake.allocator';
import type {
  LotAllocation,
  OrderOutcome,
  RiskDecision,
  SignalAllocation,
  TradeSignal,
} from './bot.types';

/** Signals already handled by this platform (idempotency guard). */
function signalClaimKey(signalId: string): string {
  // A plain, stable key. Deliberately NOT namespaced with the Redis key helper:
  // the durable claim row stores it verbatim, and the deposit/payout claims use
  // the same convention (`ipn:<...>`, `payout-ipn:<...>`).
  return `signal-claimed:${signalId}`;
}

/** Highest master-account equity seen, used as the drawdown peak. */
function masterPeakEquityKey(derivAccountId: string): string {
  return rkey('master-peak-equity', derivAccountId);
}

/** How long a processed signal is remembered (broker time is irrelevant here). */
const SIGNAL_CLAIM_TTL_SECONDS = 24 * 60 * 60;

export interface SignalExecutionResult {
  signalId: string;
  status: 'REJECTED' | 'NO_CONNECTION' | 'NO_ALLOCATIONS' | 'EXECUTED';
  reason?: string;
  decision?: RiskDecision;
  allocations: SignalAllocation[];
  outcomes: OrderOutcome[];
}

export interface ClosePositionInput {
  brokerConnectionId: string;
  investmentId: string;
  positionId: string;
  /** Partial volume; omitted/0 closes the whole position. */
  volume?: number;
}

export interface ClosePositionOutcome {
  ok: boolean;
  positionId: string;
  investmentId: string;
  /** True when the TradeRecord was closed in this call. */
  tradeClosed: boolean;
  /** True when the broker still holds a remainder of the position. */
  partialOnly: boolean;
  closePrice?: number;
  netPnL?: number;
  brokerMessage?: string;
  errorCode?: string;
}

// -------------------------------------------------------------- capabilities

/**
 * Contract-broker gate.
 *
 * Deriv prices orders as a contract — a stake in account currency times a
 * multiplier — while this pipeline is MT5-shaped end to end: the lot allocator
 * derives `volume` from the symbol's lot step, the risk engine reasons in lots,
 * and the ledger computes open exposure as `volume x entryPrice`. None of those
 * numbers exist on a contract broker.
 *
 * Bridging them would mean inventing a contract size, and that invented number
 * would decide how much client money is put at risk. So a signal for a
 * non-lot-denominated broker is REFUSED here, with an audit row naming the
 * reason. Enabling contract trading needs the exposure-model decision documented
 * in PRODUCTION-READINESS.md plus a stake-aware allocator.
 */
function isLotDenominated(adapter: BrokerAdapter): boolean {
  return adapter.sizeDenomination === 'lots';
}

// -------------------------------------------------------------- aggregation

interface ActiveInvestment {
  id: string;
  capitalUsd: number;
  currentValUsd: number;
  maxDrawdownPct: number;
}

/**
 * ACTIVE investments that trade on this broker connection.
 *
 * The schema has no `Investment.brokerId`, so the link is derived from booked
 * trades: an investment counts as "on this broker" when it already has a trade on
 * this connection. In a single-connection deployment (which this runtime is
 * documented for) every ACTIVE investment belongs to that master account, so all
 * of them are returned.
 */
async function resolveActiveInvestments(connectionId: string): Promise<ActiveInvestment[]> {
  const connectionCount = await prisma.brokerConnection.count();
  const linked = await prisma.tradeRecord.findMany({
    where: { brokerId: connectionId },
    select: { investmentId: true },
    distinct: ['investmentId'],
  });
  const linkedIds = linked.map((row) => row.investmentId);

  const investments = await prisma.investment.findMany({
    where: {
      status: 'ACTIVE',
      ...(connectionCount > 1 && linkedIds.length > 0 ? { id: { in: linkedIds } } : {}),
    },
    include: { plan: { select: { maxDrawdown: true } } },
    orderBy: { id: 'asc' },
  });

  return investments.map((investment) => ({
    id: investment.id,
    capitalUsd: D(investment.capitalUsd).toNumber(),
    currentValUsd: D(investment.currentValUsd).toNumber(),
    maxDrawdownPct: D(investment.plan.maxDrawdown).toNumber(),
  }));
}

// --------------------------------------------------------------- the pipeline

/**
 * Connects the adapter, reporting (audit + activity) instead of throwing when the
 * bridge is unreachable. Returns null when the signal cannot be executed at all.
 */
async function connectOrReport(
  conn: BrokerConnection,
  details: Record<string, unknown>,
): Promise<BrokerAdapter | null> {
  try {
    return await ensureBrokerConnected(await getAdapterForConnection(conn));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAuditSafe({
      action: AUDIT.BROKER_ERROR,
      details: { ...details, brokerConnectionId: conn.id, phase: 'execute_signal.connect', error: message },
    });
    await publishActivity(
      makeActivity(
        'SIGNAL_NO_CONNECTION',
        `Cannot reach broker connection ${conn.maskedAccount}: ${message}`,
        'error',
        { ...details, brokerConnectionId: conn.id },
        investmentRooms(null),
      ),
    );
    return null;
  }
}

/** Account snapshot, reported instead of thrown when the bridge answers nonsense. */
async function readAccountOrReport(
  adapter: BrokerAdapter,
  conn: BrokerConnection,
  details: Record<string, unknown>,
): Promise<BrokerAccountState | null> {
  try {
    return await adapter.getAccountState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAuditSafe({
      action: AUDIT.BROKER_ERROR,
      details: { ...details, brokerConnectionId: conn.id, phase: 'execute_signal.account_state', error: message },
    });
    await publishActivity(
      makeActivity(
        'SIGNAL_NO_ACCOUNT_STATE',
        `Broker did not return a usable account snapshot for ${conn.maskedAccount}: ${message}`,
        'error',
        { ...details, brokerConnectionId: conn.id },
        investmentRooms(null),
      ),
    );
    return null;
  }
}

/**
 * Executes one strategy signal end to end.
 *
 * Returns a summary rather than throwing: "rejected" is a normal outcome that the
 * activity feed and the audit log both record.
 */
export async function executeSignal(signal: TradeSignal): Promise<SignalExecutionResult> {
  const env = serverEnv();
  const claimKey = signalClaimKey(signal.signalId);
  const configClaim = { signalId: signal.signalId, strategy: signal.strategy, symbol: signal.symbol };

  // Platform gate: the global kill switch, the symbol allow-list and the daily
  // loss limit. Checked BEFORE the idempotency claim so a halted platform does
  // not consume the signal — the operator can re-run it after releasing the stop.
  const gate = await checkTradingAllowed(signal.symbol);
  if (!gate.allowed) {
    await recordAudit({
      action: AUDIT.RISK_KILL_SWITCH,
      details: { ...configClaim, phase: 'execute_signal', code: gate.code, reason: gate.reason },
    });
    await publishActivity(
      makeActivity(
        gate.code,
        `Signal ${signal.signalId} refused: ${gate.reason}`,
        'error',
        { ...configClaim, code: gate.code },
        investmentRooms(null),
      ),
    );
    return { signalId: signal.signalId, status: 'REJECTED', reason: gate.code, allocations: [], outcomes: [] };
  }

  const conn = await prisma.brokerConnection.findUnique({
    where: { derivAccountId: signal.brokerAccountId },
  });
  if (!conn) {
    await recordAudit({
      action: AUDIT.BROKER_ERROR,
      details: { ...configClaim, phase: 'execute_signal', reason: 'UNKNOWN_BROKER_ACCOUNT' },
    });
    await publishActivity(
      makeActivity(
        'SIGNAL_NO_BROKER',
        `Signal ${signal.signalId} targets broker account ${signal.brokerAccountId}, which is not registered.`,
        'error',
        configClaim,
        investmentRooms(null),
      ),
    );
    return { signalId: signal.signalId, status: 'NO_CONNECTION', reason: 'UNKNOWN_BROKER_ACCOUNT', allocations: [], outcomes: [] };
  }

  const adapter = await connectOrReport(conn, configClaim);
  if (!adapter) {
    return { signalId: signal.signalId, status: 'NO_CONNECTION', reason: 'BROKER_UNAVAILABLE', allocations: [], outcomes: [] };
  }

  // Duplicate protection: the claim is taken before the first broker call, so
  // two replicas racing on the same signal cannot both submit orders. The claim
  // is DURABLE and Postgres-backed: a Redis flush used to make the guard forget,
  // and a re-delivered signal then released a SECOND live broker order — a real
  // position, not a bookkeeping error.
  const claim = await claimOnceDurable(claimKey, SIGNAL_CLAIM_TTL_SECONDS);

  if (claim.retryable) {
    // The guard could not be evaluated. Skipping the signal is the only safe
    // action — trading without a claim is exactly how a duplicate order happens —
    // but it must be LOUD, because a silently skipped signal is missed exposure.
    await recordAuditSafe({
      action: AUDIT_PAYOUT.SIGNAL_CLAIM_DEGRADED,
      details: { ...configClaim, authority: claim.authority, outcome: 'SIGNAL_SKIPPED' },
    });
    await publishActivity(
      makeActivity(
        'SIGNAL_CLAIM_UNAVAILABLE',
        `Signal ${signal.signalId} was not traded: the idempotency guard could not be read. It can be re-run once the database is reachable.`,
        'error',
        { ...configClaim, outcome: 'SIGNAL_SKIPPED' },
        investmentRooms(null),
      ),
    );
    return {
      signalId: signal.signalId,
      status: 'REJECTED',
      reason: 'SIGNAL_CLAIM_UNAVAILABLE',
      allocations: [],
      outcomes: [],
    };
  }

  const duplicate = !claim.claimed;

  const account = await readAccountOrReport(adapter, conn, configClaim);
  if (!account) {
    if (claim.claimed) await releaseClaimDurable(claimKey);
    return { signalId: signal.signalId, status: 'NO_CONNECTION', reason: 'ACCOUNT_STATE_UNAVAILABLE', allocations: [], outcomes: [] };
  }

  if (adapter.sizeDenomination !== 'lots' && adapter.sizeDenomination !== 'stake') {
    const reason = 'BROKER_SIZE_DENOMINATION_UNSUPPORTED';
    await recordAudit({
      action: AUDIT.RISK_CHECK_FAILED,
      details: {
        ...configClaim,
        reason,
        sizeDenomination: adapter.sizeDenomination,
        symbol: signal.symbol,
        direction: signal.direction,
        masterVolume: signal.masterVolume,
      },
    });
    await publishActivity(
      makeActivity(
        'SIGNAL_REFUSED',
        `Signal ${signal.signalId} refused: this broker denominates size in ${adapter.sizeDenomination}, which neither the lot nor the stake sizing path can price without inventing a contract size.`,
        'warning',
        { ...configClaim, reason, sizeDenomination: adapter.sizeDenomination },
        investmentRooms(null),
      ),
    );
    if (claim.claimed) await releaseClaimDurable(claimKey);
    return { signalId: signal.signalId, status: 'REJECTED', reason, allocations: [], outcomes: [] };
  }

  // An empty position list is only ever a real "no open position" answer: when the
  // broker call fails we stop the pipeline instead of assuming flat.
  let positions: BrokerPosition[];
  try {
    positions = await adapter.getOpenPositions();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAuditSafe({
      action: AUDIT.BROKER_ERROR,
      details: { ...configClaim, phase: 'execute_signal.open_positions', error: message },
    });
    if (claim.claimed) await releaseClaimDurable(claimKey);
    return { signalId: signal.signalId, status: 'NO_CONNECTION', reason: 'POSITIONS_UNAVAILABLE', allocations: [], outcomes: [] };
  }

  const investments = await resolveActiveInvestments(conn.id);

  const capitalUsd = D(investments.reduce((acc, item) => acc.plus(item.capitalUsd), D(0)));
  const currentEquity = D(investments.reduce((acc, item) => acc.plus(item.currentValUsd), D(0)));

  // Drawdown peak: highest equity this master account has reached. Operational
  // state (Redis), never a trade value — seeded from the current ledger sum.
  const storedPeak = await redis.get(masterPeakEquityKey(conn.derivAccountId));
  const peakFromStore = storedPeak !== null && Number.isFinite(Number(storedPeak)) ? D(storedPeak) : null;
  const peakEquity = peakFromStore && peakFromStore.greaterThan(currentEquity) ? peakFromStore : currentEquity;

  // Most conservative limit across the plans funding this signal.
  const maxDrawdownPct = investments.length
    ? Math.min(...investments.map((investment) => investment.maxDrawdownPct))
    : 0;

  // Lot metadata for the allocator. A contract broker publishes none — and the
  // gate above has already refused those brokers — so null here means "this
  // broker cannot size lots" and the allocator skips instead of guessing.
  const spec: SymbolSpec | null = null;

  /*
   * The margin check, per denomination.
   *
   * LOTS (an MT5-shaped broker): no margin RPC exists any more, so the figure is
   * unknown and the check fails closed. No such broker is reachable today —
   * `placeOrder` refuses any denomination it cannot price without inventing a
   * contract size, and the only configured adapter is a stake broker.
   *
   * STAKE (Deriv multipliers): a stake IS the maximum loss on the contract, and
   * Deriv reports no free margin at all. The honest solvency question is
   * therefore "does the money this signal puts at risk fit inside what the master
   * account holds?" — the per-signal stake budget is
   * `capitalUsd x riskPerTradePct / 100` (the same budget the stake allocator
   * spends), measured against the BROKER-reported equity. Both inputs are real;
   * nothing is invented, and an unreported equity still fails closed because the
   * engine only accepts a finite number.
   *
   * CURRENCY: the budget is USD (the platform's ledger unit) and the broker
   * reports equity in the ACCOUNT's currency. Comparing them without a conversion
   * would be wrong by the FX rate, and there is no rate source on this path — so
   * the check runs only when the account reports USD and fails closed otherwise
   * (the operator sees the margin check fail and fixes the account currency).
   */
  const stakeDenominated = adapter.sizeDenomination === 'stake';
  const currencyComparable = !stakeDenominated || account.currency === 'USD';
  const requiredMargin: number | null = stakeDenominated
    ? (capitalUsd.toNumber() * getSettingNumber('risk.risk_per_trade_pct')) / 100
    : null;
  const freeMarginForGate: number | null = stakeDenominated
    ? (currencyComparable ? (account.freeMargin ?? account.equity) : null)
    : account.freeMargin;

  const symbolTradable = (await adapter.isSymbolTradable(signal.symbol)) === true;

  const riskContext: RiskContextWithFloor = {
    account,
    maxDrawdownPct,
    peakEquity: peakEquity.toNumber(),
    capitalUsd: capitalUsd.toNumber(),
    currentEquity: currentEquity.toNumber(),
    openPositions: positions.length,
    maxOpenPositions: env.RISK_MAX_OPEN_POSITIONS,
    signalVolume: signal.masterVolume,
    maxLotPerOrder: env.RISK_MAX_LOT_PER_ORDER,
    minClientCapitalUsd: env.RISK_MIN_CLIENT_CAPITAL_USD,
    duplicate,
    freeMargin: freeMarginForGate,
    requiredMargin,
    symbolTradable,
    masterEquityFloorUsd: env.RISK_MASTER_EQUITY_FLOOR_USD,
  };

  const decision = evaluatePreTradeRisk(riskContext);
  await recordAudit({
    action: decision.passed ? AUDIT.RISK_CHECK_PASSED : AUDIT.RISK_CHECK_FAILED,
    details: {
      ...configClaim,
      brokerConnectionId: conn.id,
      masterVolume: signal.masterVolume,
      direction: signal.direction,
      rejectionReason: decision.rejectionReason ?? null,
      checks: decision.checks.map((entry) => ({
        name: entry.name,
        passed: entry.passed,
        detail: entry.detail,
        observed: entry.observed ?? null,
        threshold: entry.threshold ?? null,
      })),
    },
  });

  if (!decision.passed) {
    // The signal never reached the broker, so the claim is released for a retry.
    if (claim.claimed) await releaseClaimDurable(claimKey);
    await publishActivity(
      makeActivity(
        'SIGNAL_REJECTED',
        `Signal ${signal.signalId} (${signal.direction} ${signal.masterVolume} ${signal.symbol}) rejected by risk: ${decision.rejectionReason ?? 'unknown'}.`,
        'warning',
        { ...configClaim, rejectionReason: decision.rejectionReason ?? null, checks: decision.checks },
        investmentRooms(null),
      ),
    );
    return { signalId: signal.signalId, status: 'REJECTED', decision, allocations: [], outcomes: [] };
  }

  // The master high-water mark only ever moves up. Redis holds this operational
  // state (the schema has no peak-equity column); it is seeded from the ledger.
  const masterNow = D(account.equity).greaterThan(currentEquity) ? D(account.equity) : currentEquity;
  if (!peakFromStore || peakFromStore.lessThan(masterNow)) {
    await redis.set(masterPeakEquityKey(conn.derivAccountId), masterNow.toString());
  }

  let allocations: SignalAllocation[];

  if (adapter.sizeDenomination === 'stake') {
    /*
     * Stake sizing. The client's own capital and the plan's drawdown stop are the
     * inputs — NOT the master account's lot size or equity, which describe the
     * broker account rather than the money being risked. A symbol spec is
     * therefore not required here: Deriv publishes none for contracts, and
     * demanding one was what used to refuse every contract order.
     */
    const riskPerTradePct = getSettingNumber('risk.risk_per_trade_pct');
    const platformCapUsd = getSettingNumber('risk.max_stake_usd');
    const multiplier = adapter.stakeMultiplier ?? 0;

    allocations = investments.map((investment) => {
      const sized = allocateStake({
        capitalUsd: investment.capitalUsd,
        currentValUsd: investment.currentValUsd,
        maxDrawdownPct: investment.maxDrawdownPct,
        riskPerTradePct,
        platformCapUsd,
        multiplier,
      });
      const stake = sized.stake ?? 0;
      return {
        denomination: 'stake' as const,
        investmentId: investment.id,
        stake,
        notional: sized.notional ?? 0,
        ratio:
          investment.capitalUsd !== null && investment.capitalUsd > 0
            ? stake / investment.capitalUsd
            : 0,
        skipped: sized.skipped,
        ...(sized.skipReason ? { skipReason: sized.skipReason } : {}),
        bounds: sized.bounds,
      };
    });
  } else {
    if (!spec) {
      // Unreachable when the risk gate passed (SYMBOL_NOT_TRADABLE would have fired),
      // but the pipeline must not continue without a real specification — and the
      // claim must be released so a fixed retry is not blocked for the full TTL.
      if (claim.claimed) await releaseClaimDurable(claimKey);
      return { signalId: signal.signalId, status: 'NO_ALLOCATIONS', reason: 'NO_SYMBOL_SPEC', decision, allocations: [], outcomes: [] };
    }

    if (account.equity === null) {
      // Sizing scales client lots against master equity; without a figure that is
      // not a scale factor, it is a division by an unknown.
      if (claim.claimed) await releaseClaimDurable(claimKey);
      return {
        signalId: signal.signalId,
        status: 'NO_CONNECTION',
        reason: 'MASTER_EQUITY_UNREPORTED',
        allocations: [],
        outcomes: [],
      };
    }

    allocations = allocateAcrossInvestments({
      masterVolume: signal.masterVolume,
      masterEquity: account.equity,
      symbolSpec: spec,
      minClientCapitalUsd: env.RISK_MIN_CLIENT_CAPITAL_USD,
      investments: investments.map((investment) => ({
        investmentId: investment.id,
        capitalUsd: investment.capitalUsd,
      })),
    }).map((allocation) => ({ denomination: 'lots' as const, ...allocation }));
  }

  // Audit every allocation (including the skipped ones) before touching the broker.
  for (const allocation of allocations) {
    if (allocation.denomination === 'stake') {
      await recordAudit({
        action: AUDIT.STAKE_ALLOCATED,
        details: {
          ...configClaim,
          investmentId: allocation.investmentId,
          stake: allocation.stake,
          notional: allocation.notional,
          multiplier: adapter.stakeMultiplier ?? null,
          ratioOfCapital: allocation.ratio,
          skipped: allocation.skipped,
          skipReason: allocation.skipReason ?? null,
          bounds: allocation.bounds,
        },
      });
      continue;
    }

    await recordAudit({
      action: AUDIT.LOT_ALLOCATED,
      details: {
        ...configClaim,
        investmentId: allocation.investmentId,
        masterVolume: signal.masterVolume,
        masterEquity: account.equity,
        clientVolume: allocation.clientVolume,
        ratio: allocation.ratio,
        skipped: allocation.skipped,
        skipReason: allocation.skipReason ?? null,
        formula: MASTER_TO_CLIENT_FORMULA,
      },
    });
  }

  const executable = allocations.filter((allocation) => !allocation.skipped);
  if (executable.length === 0) {
    if (claim.claimed) await releaseClaimDurable(claimKey);
    await publishActivity(
      makeActivity(
        'SIGNAL_NO_ALLOCATION',
        `Signal ${signal.signalId} produced no executable allocation (all investments skipped).`,
        'warning',
        { ...configClaim, allocations },
        investmentRooms(null),
      ),
    );
    return { signalId: signal.signalId, status: 'NO_ALLOCATIONS', decision, allocations, outcomes: [] };
  }

  const outcomes: OrderOutcome[] = [];
  for (const allocation of executable) {
    const clientOrderId = `sig:${signal.signalId}:inv:${allocation.investmentId}`;
    const request: PlaceOrderRequest = {
      symbol: signal.symbol,
      direction: signal.direction,
      // One or the other, never both: a request carrying a lot size to a stake
      // broker is refused by the adapter rather than converted.
      ...(allocation.denomination === 'stake'
        ? { stake: allocation.stake }
        : { volume: allocation.clientVolume }),
      ...(signal.stopLoss !== undefined ? { stopLoss: signal.stopLoss } : {}),
      ...(signal.takeProfit !== undefined ? { takeProfit: signal.takeProfit } : {}),
      comment: clientOrderId,
      clientOrderId,
    };

    await recordAudit({
      action: AUDIT.BROKER_ORDER_SUBMITTED,
      details: {
        ...configClaim,
        investmentId: allocation.investmentId,
        clientOrderId,
        symbol: request.symbol,
        direction: request.direction,
        volume: request.volume ?? null,
        stake: request.stake ?? null,
        stopLoss: request.stopLoss ?? null,
        takeProfit: request.takeProfit ?? null,
      },
    });

    let result: Awaited<ReturnType<BrokerAdapter['placeOrder']>>;
    try {
      result = await adapter.placeOrder(request);
    } catch (err) {
      // placeOrder maps broker rejections itself; anything thrown here is an
      // infrastructure failure and is reported the same way.
      result = {
        ok: false,
        errorCode: 'ORDER_LAYER_ERROR',
        brokerMessage: err instanceof Error ? err.message : 'Unknown order error',
      };
    }

    const outcome: OrderOutcome = {
      investmentId: allocation.investmentId,
      request,
      ok: result.ok,
      ...(result.positionId !== undefined ? { positionId: result.positionId } : {}),
      ...(result.fillPrice !== undefined ? { fillPrice: result.fillPrice } : {}),
      ...(result.brokerMessage !== undefined ? { brokerMessage: result.brokerMessage } : {}),
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    };
    outcomes.push(outcome);

    if (!result.ok) {
      await recordAudit({
        action: AUDIT.BROKER_ORDER_REJECTED,
        details: {
          ...configClaim,
          investmentId: allocation.investmentId,
          clientOrderId,
          errorCode: result.errorCode ?? null,
          brokerMessage: result.brokerMessage ?? null,
        },
      });
      await publishActivity(
        makeActivity(
          'ORDER_REJECTED',
          `Broker rejected ${request.direction} ${request.volume} ${request.symbol} for investment ${allocation.investmentId}: ${result.brokerMessage ?? result.errorCode ?? 'unknown error'}.`,
          'error',
          {
            ...configClaim,
            investmentId: allocation.investmentId,
            clientOrderId,
            errorCode: result.errorCode ?? null,
          },
          investmentRooms(allocation.investmentId),
        ),
      );
      continue;
    }

    await recordAudit({
      action: AUDIT.BROKER_ORDER_FILLED,
      details: {
        ...configClaim,
        investmentId: allocation.investmentId,
        clientOrderId,
        orderId: result.orderId ?? null,
        positionId: result.positionId ?? null,
        fillPrice: result.fillPrice ?? null,
        filledVolume: result.volume ?? null,
        brokerMessage: result.brokerMessage ?? null,
      },
    });

    // The ledger row is written ONLY when the broker reported the position id, the
    // fill price and the filled volume. Missing any of them → no row here; the
    // sync cycle reconciles the position from the broker's own record.
    if (result.positionId && result.fillPrice !== undefined && result.volume !== undefined) {
      try {
        await prisma.tradeRecord.create({
          data: {
            investmentId: allocation.investmentId,
            brokerId: conn.id,
            derivContractId: result.positionId,
            instrument: request.symbol,
            direction: request.direction,
            volume: toPrismaDecimal(
              result.volume ??
                (allocation.denomination === 'stake' ? allocation.stake : allocation.clientVolume),
              5,
            ),
            notional:
              result.notional === undefined || result.notional === null
                ? null
                : toPrismaDecimal(result.notional, 2),
            entryPrice: toPrismaDecimal(result.fillPrice, 5),
            stopLoss: request.stopLoss === undefined ? null : toPrismaDecimal(request.stopLoss, 5),
            takeProfit: request.takeProfit === undefined ? null : toPrismaDecimal(request.takeProfit, 5),
            status: 'OPEN',
            // The next sync cycle replaces this with the broker's own open time.
            openedAt: new Date(),
          },
        });
        await publishTradeEvent(
          WS_EVENTS.positionOpened,
          {
            positionId: result.positionId,
            investmentId: allocation.investmentId,
            instrument: request.symbol,
            direction: request.direction,
            volume: result.volume,
            entryPrice: result.fillPrice,
            clientOrderId,
          },
          investmentRooms(allocation.investmentId),
        );
      } catch (err) {
        await recordAuditSafe({
          action: AUDIT.BROKER_ERROR,
          details: {
            ...configClaim,
            investmentId: allocation.investmentId,
            positionId: result.positionId,
            phase: 'trade_record_create',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } else {
      await recordAuditSafe({
        action: AUDIT.BROKER_ERROR,
        details: {
          ...configClaim,
          investmentId: allocation.investmentId,
          positionId: result.positionId ?? null,
          phase: 'fill_details_missing',
          note: 'Broker confirmed the order but did not report position id / fill price / volume yet; no ledger row written, the sync cycle will reconcile it.',
        },
      });
    }

    await publishActivity(
      makeActivity(
        'ORDER_FILLED',
        `Filled ${request.direction} ${result.volume ?? request.volume} ${request.symbol} for investment ${allocation.investmentId}${result.fillPrice !== undefined ? ` @ ${result.fillPrice}` : ''}.`,
        'success',
        {
          ...configClaim,
          investmentId: allocation.investmentId,
          positionId: result.positionId ?? null,
          clientOrderId,
        },
        investmentRooms(allocation.investmentId),
      ),
    );
  }

  const filled = outcomes.filter((outcome) => outcome.ok).length;
  await publishActivity(
    makeActivity(
      'SIGNAL_EXECUTED',
      `Signal ${signal.signalId}: ${filled}/${outcomes.length} mirrored orders confirmed by the broker.`,
      filled > 0 ? 'success' : 'warning',
      { ...configClaim, filled, attempted: outcomes.length },
      investmentRooms(null),
    ),
  );

  return { signalId: signal.signalId, status: 'EXECUTED', decision, allocations, outcomes };
}

// -------------------------------------------------------------------- closing

/**
 * Closes a booked position for one investment: broker close → TradeRecord closure
 * (from the broker's closing deals) → investment roll-up.
 *
 * A partial close leaves the position open at the broker, so the TradeRecord stays
 * OPEN; its realised part is picked up when the position is finally closed, because
 * the closure aggregate always sums *every* closing deal of the position.
 */
export async function closePositionForInvestment(input: ClosePositionInput): Promise<ClosePositionOutcome> {
  const conn = await prisma.brokerConnection.findUnique({ where: { id: input.brokerConnectionId } });
  if (!conn) throw ApiError.notFound('Broker connection not found.');

  const trade = await prisma.tradeRecord.findUnique({
    where: {
      brokerId_derivContractId: {
        brokerId: input.brokerConnectionId,
        derivContractId: input.positionId,
      },
    },
  });
  if (!trade || trade.investmentId !== input.investmentId) {
    // Refuse to close a position the platform cannot attribute to this investment.
    throw ApiError.notFound('No booked position matches this investment and position id.');
  }

  const adapter = await ensureBrokerConnected(await getAdapterForConnection(conn));
  const result = await adapter.closePosition(input.positionId, input.volume);

  if (!result.ok) {
    await recordAudit({
      action: AUDIT.BROKER_ORDER_REJECTED,
      details: {
        brokerConnectionId: conn.id,
        investmentId: input.investmentId,
        derivContractId: input.positionId,
        phase: 'close_position',
        errorCode: result.errorCode ?? null,
        brokerMessage: result.brokerMessage ?? null,
      },
    });
    return {
      ok: false,
      positionId: input.positionId,
      investmentId: input.investmentId,
      tradeClosed: false,
      partialOnly: false,
      ...(result.brokerMessage !== undefined ? { brokerMessage: result.brokerMessage } : {}),
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    };
  }

  const remaining: BrokerPosition[] = await adapter.getOpenPositions();
  const stillOpen = remaining.some((position) => position.positionId === input.positionId);

  let tradeClosed = false;
  let closePrice = result.closePrice;
  let netPnL = result.netPnL;

  if (stillOpen) {
    // Broker confirmed a partial fill: book nothing against the open row yet.
    await recordAuditSafe({
      action: 'METAAPI_POSITION_PARTIALLY_CLOSED',
      details: {
        brokerConnectionId: conn.id,
        investmentId: input.investmentId,
        derivContractId: input.positionId,
        requestedVolume: input.volume ?? null,
        note: 'Position is still open at the broker; TradeRecord stays OPEN until the closing deal set is complete.',
      },
    });
  } else if (supportsPositionClosure(adapter)) {
    const closure = await adapter.getPositionClosure(input.positionId);
    if (closure) {
      const applied = await applyPositionClosure(conn.id, closure);
      tradeClosed = applied !== null;
      if (closure.exitPrice !== null) closePrice = closure.exitPrice;
      netPnL = closure.netPnL;
    } else {
      await recordAuditSafe({
        action: AUDIT.BROKER_ERROR,
        details: {
          brokerConnectionId: conn.id,
          investmentId: input.investmentId,
          derivContractId: input.positionId,
          phase: 'close_position_closure',
          note: 'Broker reported no closing deal yet; TradeRecord left OPEN for the sync cycle.',
        },
      });
    }
  }

  const unrealized = D(
    remaining
      .filter((position) => position.investmentId === input.investmentId)
      .reduce((acc, position) => acc.plus(position.unrealizedPnL), D(0)),
  ).toNumber();
  await recomputeInvestment(input.investmentId, unrealized);

  await publishActivity(
    makeActivity(
      tradeClosed ? 'POSITION_CLOSED' : 'POSITION_PARTIALLY_CLOSED',
      tradeClosed
        ? `Position ${input.positionId} closed${netPnL !== undefined ? ` with net P/L ${usd(netPnL).toString()}` : ''} for investment ${input.investmentId}.`
        : `Position ${input.positionId} partially closed for investment ${input.investmentId}.`,
      tradeClosed ? 'success' : 'info',
      {
        brokerConnectionId: conn.id,
        investmentId: input.investmentId,
        derivContractId: input.positionId,
        netPnL: netPnL ?? null,
      },
      investmentRooms(input.investmentId),
    ),
  );

  return {
    ok: true,
    positionId: input.positionId,
    investmentId: input.investmentId,
    tradeClosed,
    partialOnly: stillOpen,
    ...(closePrice !== undefined ? { closePrice } : {}),
    ...(netPnL !== undefined ? { netPnL } : {}),
    ...(result.brokerMessage !== undefined ? { brokerMessage: result.brokerMessage } : {}),
  };
}
