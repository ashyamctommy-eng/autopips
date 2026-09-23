/**
 * Pre-trade risk gate.
 *
 * PURE: no I/O, no Prisma, no Redis, no clock, no randomness. Everything the gate
 * needs is passed in through `RiskContext`, which makes every rule unit-testable
 * without a broker connection or a database.
 *
 * Fail-closed by design — an unevaluable check is a rejection.
 * Every input that is missing, non-finite or structurally wrong fails its check;
 * there is no "assume it fits" branch anywhere in this file.
 *
 * All checks are evaluated (so the admin activity feed can show the full picture)
 * and the decision carries the *first* failure in the documented order.
 */

import { D, Decimal, type Numeric } from '@/lib/money';
import type { RiskCheck, RiskContext, RiskDecision, RiskRejectionReason } from './bot.types';

/** Account states in which the bridge cannot trade (mirrors the adapter). */
const TERMINAL_ERROR_STATES: readonly string[] = [
  'DEPLOY_FAILED',
  'UNDEPLOY_FAILED',
  'DELETE_FAILED',
  'REDEPLOY_FAILED',
];

/**
 * `RiskContext` plus the one operational limit the engine is not allowed to read
 * itself (it must stay pure): the master-account equity floor.
 * Callers pass `serverEnv().RISK_MASTER_EQUITY_FLOOR_USD`; when omitted the floor
 * rule degrades to "equity must be > 0".
 */
export interface RiskContextWithFloor extends RiskContext {
  masterEquityFloorUsd?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Drawdown of the master account measured against the capital at risk:
 *
 *   drawdownPct = (peakEquity − currentEquity) / capitalUsd × 100
 *
 * `capitalUsd <= 0` cannot produce a ratio. It returns `Infinity` — the
 * fail-closed value (any finite limit is breached) — rather than 0, which would
 * silently auto-pass; the engine additionally rejects that case explicitly in the
 * DRAWDOWN_BREACHED check.
 */
export function computeDrawdownPct(peakEquity: Numeric, currentEquity: Numeric, capitalUsd: Numeric): number {
  const capital = D(capitalUsd);
  if (capital.lessThanOrEqualTo(0)) return Number.POSITIVE_INFINITY;
  return D(peakEquity)
    .minus(D(currentEquity))
    .div(capital)
    .times(100)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toNumber();
}

function check(
  name: string,
  reason: RiskRejectionReason,
  passed: boolean,
  detail: string,
  extra: { observed?: number | string; threshold?: number | string } = {},
): RiskCheck {
  return { name, passed, detail, reason, ...extra };
}

/**
 * Evaluates the nine pre-trade rules, in this order:
 *
 *   1. ACCOUNT_NOT_ACTIVE          — trading enabled and not in a terminal error state
 *   2. BROKER_DISCONNECTED         — account status must be CONNECTED
 *   3. DUPLICATE_SIGNAL            — signalId must not have been processed
 *   4. MASTER_EQUITY_FLOOR_BREACHED— equity > 0 and above the configured floor
 *   5. DRAWDOWN_BREACHED           — drawdown < maxDrawdownPct (capitalUsd > 0)
 *   6. MAX_OPEN_POSITIONS_REACHED  — openPositions < maxOpenPositions
 *   7. LOT_TOO_LARGE               — 0 < signalVolume <= maxLotPerOrder
 *   8. SYMBOL_NOT_TRADABLE         — broker reports the symbol as tradable
 *   9. INSUFFICIENT_FREE_MARGIN    — requiredMargin is known and <= freeMargin
 */
export function evaluatePreTradeRisk(ctx: RiskContextWithFloor): RiskDecision {
  const checks: RiskCheck[] = [];

  // 1 ── account active ------------------------------------------------------
  const rawState = ctx.account.rawState;
  const terminalError = typeof rawState === 'string' && TERMINAL_ERROR_STATES.includes(rawState);
  const accountActive = ctx.account.isTradingEnabled === true && !terminalError;
  checks.push(
    check(
      'ACCOUNT_NOT_ACTIVE',
      'ACCOUNT_NOT_ACTIVE',
      accountActive,
      accountActive
        ? 'Broker reports the account as tradeable.'
        : terminalError
          ? `Account is in terminal error state ${rawState}.`
          : 'Broker reports trading as disabled for this account.',
      { observed: rawState, threshold: 'isTradingEnabled' },
    ),
  );

  // 2 ── connection ----------------------------------------------------------
  const connected = ctx.account.status === 'CONNECTED';
  checks.push(
    check(
      'BROKER_DISCONNECTED',
      'BROKER_DISCONNECTED',
      connected,
      connected ? 'Broker connection is CONNECTED.' : `Broker connection is ${ctx.account.status}.`,
      { observed: ctx.account.status, threshold: 'CONNECTED' },
    ),
  );

  // 3 ── duplicate signal ----------------------------------------------------
  const duplicate = ctx.duplicate === true;
  checks.push(
    check(
      'DUPLICATE_SIGNAL',
      'DUPLICATE_SIGNAL',
      !duplicate,
      duplicate ? 'This signalId has already been processed.' : 'Signal id is new.',
    ),
  );

  // 4 ── master equity floor -------------------------------------------------
  const equity = ctx.account.equity;
  const floor = ctx.masterEquityFloorUsd;
  const floorKnown = floor === undefined || isFiniteNumber(floor);
  const aboveFloor =
    isFiniteNumber(equity) && equity > 0 && (floor === undefined || (floorKnown && equity > floor));
  checks.push(
    check(
      'MASTER_EQUITY_FLOOR_BREACHED',
      'MASTER_EQUITY_FLOOR_BREACHED',
      aboveFloor,
      aboveFloor
        ? floor === undefined
          ? 'Master equity is positive.'
          : `Master equity ${equity.toFixed(2)} is above the floor ${floor.toFixed(2)}.`
        : isFiniteNumber(equity)
          ? `Master equity ${equity.toFixed(2)} is at or below the floor ${floor === undefined ? 0 : floor.toFixed(2)}.`
          : 'Master equity is not a usable number.',
      { observed: isFiniteNumber(equity) ? equity : String(equity), threshold: floor ?? 0 },
    ),
  );

  // 5 ── drawdown ------------------------------------------------------------
  const capital = D(ctx.capitalUsd);
  const capitalUsable =
    isFiniteNumber(ctx.capitalUsd) && capital.greaterThan(0) && isFiniteNumber(ctx.peakEquity) && isFiniteNumber(ctx.currentEquity);
  const limitFinite = isFiniteNumber(ctx.maxDrawdownPct) && ctx.maxDrawdownPct > 0;
  const drawdownPct = capitalUsable ? computeDrawdownPct(ctx.peakEquity, ctx.currentEquity, ctx.capitalUsd) : null;
  const drawdownOk = capitalUsable && limitFinite && drawdownPct !== null && drawdownPct < ctx.maxDrawdownPct;
  const drawdownDetail =
    drawdownOk && drawdownPct !== null
      ? `Drawdown ${drawdownPct.toFixed(4)}% is inside the ${ctx.maxDrawdownPct}% limit.`
      : !capitalUsable
        ? 'Drawdown cannot be evaluated (capital or equity is unknown/non-positive); treated as breached.'
        : !limitFinite
          ? 'The investment max-drawdown limit is not a usable number; treated as breached.'
          : `Drawdown ${drawdownPct === null ? 'n/a' : drawdownPct.toFixed(4)}% has reached the ${ctx.maxDrawdownPct}% limit.`;
  checks.push(
    check('DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED', drawdownOk, drawdownDetail, {
      observed: drawdownPct ?? 'unknown',
      threshold: ctx.maxDrawdownPct,
    }),
  );

  // 6 ── open positions ------------------------------------------------------
  const limitsUsable = isFiniteNumber(ctx.openPositions) && isFiniteNumber(ctx.maxOpenPositions);
  const positionsOk = limitsUsable && ctx.openPositions < ctx.maxOpenPositions;
  checks.push(
    check(
      'MAX_OPEN_POSITIONS_REACHED',
      'MAX_OPEN_POSITIONS_REACHED',
      positionsOk,
      positionsOk
        ? `${ctx.openPositions} of ${ctx.maxOpenPositions} position slots used.`
        : limitsUsable
          ? `${ctx.openPositions} open positions have reached the limit of ${ctx.maxOpenPositions}.`
          : 'Open-position count or limit is not a usable number; treated as reached.',
      { observed: ctx.openPositions, threshold: ctx.maxOpenPositions },
    ),
  );

  // 7 ── lot size ------------------------------------------------------------
  const volumeUsable =
    isFiniteNumber(ctx.signalVolume) && ctx.signalVolume > 0 && isFiniteNumber(ctx.maxLotPerOrder) && ctx.maxLotPerOrder > 0;
  const volumeOk = volumeUsable && ctx.signalVolume <= ctx.maxLotPerOrder;
  checks.push(
    check(
      'LOT_TOO_LARGE',
      'LOT_TOO_LARGE',
      volumeOk,
      volumeOk
        ? `Signal volume ${ctx.signalVolume} is within the ${ctx.maxLotPerOrder} lot limit.`
        : volumeUsable
          ? `Signal volume ${ctx.signalVolume} exceeds the ${ctx.maxLotPerOrder} lot limit.`
          : `Signal volume ${String(ctx.signalVolume)} is not a usable lot size.`,
      { observed: ctx.signalVolume, threshold: ctx.maxLotPerOrder },
    ),
  );

  // 8 ── symbol tradable -----------------------------------------------------
  const symbolTradable = ctx.symbolTradable === true;
  checks.push(
    check(
      'SYMBOL_NOT_TRADABLE',
      'SYMBOL_NOT_TRADABLE',
      symbolTradable,
      symbolTradable
        ? 'Broker specification allows trading this symbol.'
        : 'Broker specification does not report this symbol as tradable.',
    ),
  );

  // 9 ── free margin ---------------------------------------------------------
  const marginKnown = isFiniteNumber(ctx.requiredMargin) && isFiniteNumber(ctx.freeMargin) && ctx.requiredMargin >= 0;
  const marginOk = marginKnown && ctx.requiredMargin !== null && ctx.requiredMargin <= ctx.freeMargin;
  checks.push(
    check(
      'INSUFFICIENT_FREE_MARGIN',
      'INSUFFICIENT_FREE_MARGIN',
      marginOk,
      marginOk
        ? `Required margin ${ctx.requiredMargin} fits inside free margin ${ctx.freeMargin}.`
        : ctx.requiredMargin === null
          ? 'Required margin is unknown (no usable symbol spec / margin RPC); treated as insufficient.'
          : marginKnown
            ? `Required margin ${ctx.requiredMargin} exceeds free margin ${ctx.freeMargin}.`
            : 'Free margin or required margin is not a usable number; treated as insufficient.',
      { observed: ctx.requiredMargin ?? 'unknown', threshold: ctx.freeMargin },
    ),
  );

  const firstFailure = checks.find((entry) => !entry.passed);
  return {
    passed: !firstFailure,
    checks,
    ...(firstFailure?.reason ? { rejectionReason: firstFailure.reason } : {}),
  };
}
