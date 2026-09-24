import type { BrokerAccountState, PlaceOrderRequest } from '../broker/broker.types';

/**
 * Bot engine contracts: strategy signal → risk gate → lot allocation → order.
 *
 * The pipeline is deliberately one-directional and each stage is a pure-ish
 * function so the risk rules are unit-testable without a broker connection.
 */

export interface TradeSignal {
  /** Deterministic id so a retried signal cannot open twice. */
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  /** Master-account lot size that this signal intends to trade. */
  masterVolume: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Human-readable reason, surfaced verbatim in the activity feed. */
  reason: string;
  /** Strategy identifier, e.g. "gold-momentum". */
  strategy: string;
  /** Which MetaApi account produced the signal. */
  brokerAccountId: string;
  createdAt: Date;
}

export type RiskRejectionReason =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'MASTER_EQUITY_UNKNOWN'
  | 'MASTER_EQUITY_FLOOR_BREACHED'
  | 'DRAWDOWN_BREACHED'
  | 'MAX_OPEN_POSITIONS_REACHED'
  | 'LOT_TOO_LARGE'
  | 'SYMBOL_NOT_TRADABLE'
  | 'INSUFFICIENT_FREE_MARGIN'
  | 'BROKER_DISCONNECTED'
  | 'DUPLICATE_SIGNAL';

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
  reason?: RiskRejectionReason;
  observed?: number | string;
  threshold?: number | string;
}

export interface RiskDecision {
  passed: boolean;
  checks: RiskCheck[];
  rejectionReason?: RiskRejectionReason;
}

export interface RiskContext {
  account: BrokerAccountState;
  /** Investment maxDrawdown limit, as a percentage (e.g. 15.0). */
  maxDrawdownPct: number;
  /** Peak equity recorded for this investment; used for drawdown. */
  peakEquity: number;
  /** Investment capital at risk; drawdown is measured on this base. */
  capitalUsd: number;
  /** Current equity attributable to this investment. */
  currentEquity: number;
  openPositions: number;
  maxOpenPositions: number;
  signalVolume: number;
  maxLotPerOrder: number;
  minClientCapitalUsd: number;
  /** True when an identical signalId was already processed. */
  duplicate: boolean;
  /**
   * Free margin available, in account currency. NULL when the broker does not
   * report margin (a contract broker): the margin rule then fails CLOSED, it
   * does not assume headroom.
   */
  freeMargin: number | null;
  /** Margin the intended order would consume. Null when the spec is unknown. */
  requiredMargin: number | null;
  symbolTradable: boolean;
}

export interface LotAllocation {
  investmentId: string;
  /** Client lot size after scaling and spec rounding. */
  clientVolume: number;
  /** Rounded down to the symbol's volume step; never zero unless skipped. */
  skipped: boolean;
  skipReason?:
    | 'BELOW_MIN_VOLUME'
    | 'BELOW_MIN_CAPITAL'
    | 'CAPITAL_UNKNOWN'
    | 'MASTER_EQUITY_ZERO'
    | 'SYMBOL_SPEC_UNKNOWN';
  /** The raw ratio before rounding, for auditability. */
  ratio: number;
}

export interface OrderOutcome {
  investmentId: string;
  request: PlaceOrderRequest;
  ok: boolean;
  positionId?: string;
  fillPrice?: number;
  brokerMessage?: string;
  errorCode?: string;
}

export type ActivitySeverity = 'info' | 'success' | 'warning' | 'error';

export interface BotActivity {
  id: string;
  action: string;
  message: string;
  severity: ActivitySeverity;
  details: Record<string, unknown>;
  createdAt: string;
  /** Socket room target: "trading:<investmentId>" or "admin". */
  rooms: string[];
}
