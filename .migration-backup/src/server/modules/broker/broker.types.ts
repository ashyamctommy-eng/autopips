/**
 * Broker abstraction contract.
 *
 * Everything above this boundary (bot engine, accounting, API, UI) talks to
 * these types only. Deriv is an implementation detail behind `BrokerAdapter`.
 *
 * ZERO SIMULATION: an implementation of this interface may only return data it
 * actually received from the broker. There is no `mockMode`.
 *
 * TWO BROKER MODELS, ONE INTERFACE — read this before adding a field.
 * The platform was originally written against an MT4/MT5 bridge, where a
 * position is "lots of an instrument" and the account reports margin,
 * leverage and swap. Deriv trades CONTRACTS instead: a stake (the buy price)
 * multiplied by a multiplier, with an entry/exit spot and a net profit, and it
 * reports NO lots, NO contract size, NO tick value, NO free margin and NO
 * separate commission or swap.
 *
 * Because inventing a number for a field the broker never reported is exactly
 * what this platform forbids, every MT5-only field below is `| null` and is
 * expected to be null for a contract broker. A caller that needs one of them
 * must handle "the broker did not report this" explicitly — it may not default
 * it to zero.
 */

export type BrokerEnvironment = 'LIVE' | 'DEMO';
export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface BrokerAccountState {
  /** The broker's own account identifier (MT5 login / Deriv loginid). */
  accountId: string;
  brokerName: string;
  environment: BrokerEnvironment;
  /** e.g. "***-9012" — never the full login. */
  maskedAccount: string;
  /** Broker-reported account currency, e.g. "USD". */
  currency: string;
  /** Broker-reported account balance. Null when the broker reported none. */
  balance: number | null;
  /**
   * balance + broker-reported unrealised profit on open contracts. Null only
   * when the broker reported neither figure.
   */
  equity: number | null;
  /** MT5 concept — Deriv does not report it. Null, never zero-filled. */
  freeMargin: number | null;
  /** MT5 concept — null for a contract broker. */
  margin: number | null;
  /** MT5 concept — null for a contract broker. */
  leverage: number | null;
  /** True only when the terminal reports an actionable trading state. */
  isTradingEnabled: boolean;
  status: BrokerStatus;
  /** Raw terminal state string from the bridge, e.g. "DEPLOYED". */
  rawState: string;
  updatedAt: Date;
}

export interface BrokerPosition {
  positionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Lots. NULL for a contract broker, which reports no lot size at all. */
  volume: number | null;
  /** Deriv: the contract's buy price in account currency. Null for MT5. */
  stakeUsd: number | null;
  /** Deriv: the contract's multiplier. Null for MT5. */
  multiplier: number | null;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Broker-reported unrealised P/L in account currency. */
  unrealizedPnL: number;
  /** Null when the broker reports net profit only (Deriv). */
  commission: number | null;
  swap: number | null;
  comment: string | null;
  openedAt: Date;
  /** Which client investment this position is mirrored into, if any. */
  investmentId: string | null;
}

export interface BrokerDeal {
  dealId: string;
  positionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Lots. NULL for a contract broker (Deriv settles in stake, not lots). */
  volume: number | null;
  price: number;
  /** Signed broker profit before costs. Null when only the net was reported. */
  grossPnL: number | null;
  /** Null when the broker does not report commission separately (Deriv). */
  commission: number | null;
  /** Null when the broker does not report swap separately (Deriv). */
  swap: number | null;
  /** The broker's net profit for the deal. */
  netPnL: number;
  executedAt: Date;
  comment: string | null;
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * What the broker will tell us about an instrument.
 *
 * Deliberately NOT `SymbolSpec`: lot step, lot bounds, contract size and tick
 * value do not exist on a contract broker, and a caller that sizes positions
 * from them (the lot allocator) cannot be served by this — which is why
 * `sizeDenomination` below is part of the adapter contract.
 */
export interface InstrumentInfo {
  symbol: string;
  /** Human label as the broker names it, e.g. "Volatility 100 Index". */
  displayName: string;
  market: string;
  submarket: string;
  /** Smallest price increment the instrument quotes in (Deriv: `pip`). */
  pipSize: number;
  isTradable: boolean;
}

/**
 * MT4/MT5 position-sizing input: lots and their bounds.
 *
 * LEGACY, and only reachable through `sizeDenomination === 'lots'`. A contract
 * broker (Deriv) has none of these numbers, so an adapter that reports 'stake'
 * must never be asked to produce one — `order.manager` refuses the order first.
 */
export interface SymbolSpec {
  symbol: string;
  digits: number;
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  contractSize: number;
  tickValue: number;
}

/**
 * How an adapter denominates size.
 *
 *   'lots'  — MT4/MT5: `volume` is lots, exposure is volume x price.
 *   'stake' — Deriv contracts: size is a stake in account currency and
 *             exposure is stake x multiplier. A caller that only knows how to
 *             produce lots MUST refuse the order rather than guess a stake.
 */
export type SizeDenomination = 'lots' | 'stake';

export interface PlaceOrderRequest {
  symbol: string;
  direction: 'BUY' | 'SELL';
  /** Lots. Required by a 'lots' adapter; ignored by a 'stake' adapter. */
  volume?: number;
  /** Account-currency stake. Required by a 'stake' adapter (Deriv). */
  stake?: number;
  /** Contract multiplier (Deriv multipliers, e.g. 100). */
  multiplier?: number;
  /** Absolute price levels. Deriv multipliers accept both. */
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /** Client-supplied idempotency key so a retry cannot double-open. */
  clientOrderId: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  orderId?: string;
  positionId?: string;
  /** Filled/dealt price as reported by the broker. */
  fillPrice?: number;
  /**
   * Lots for a lot-denominated broker; the STAKE (money at risk, and the maximum
   * loss) for a stake-denominated one. Null when the broker reported neither.
   */
  volume?: number | null;
  /**
   * Notional exposure the position opened, in account currency, when the broker
   * defines one. For a Deriv multiplier contract this is stake × multiplier and
   * is NOT `volume × price` — the ledger stores it so the exposure metric does
   * not have to guess which meaning `volume` carries.
   */
  notional?: number | null;
  brokerMessage?: string;
  errorCode?: string;
}

export interface ClosePositionResult {
  ok: boolean;
  positionId: string;
  closePrice?: number;
  netPnL?: number;
  brokerMessage?: string;
  errorCode?: string;
}

/**
 * A price tick.
 *
 * `bid`/`ask` are present for instruments that quote a spread. Deriv's
 * synthetic indices quote ONE number, delivered as `quote`, so a tick may carry
 * `quote` with both sides null — the broker's own price, not an average we
 * invented to fill the gap. Consumers must handle "one side reported" (see
 * `tickPrice` in src/lib/candle-aggregator.ts).
 */
export interface Quote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  /** Single-price instruments (Deriv synthetics). Null when bid/ask were sent. */
  quote?: number | null;
  time: number;
}

/**
 * How a position ended, as reported by the broker.
 *
 * `closingVolume`, `commission` and `swap` are MT5 concepts: a contract broker
 * reports the exit spot and the net profit, and leaves the rest null rather
 * than zero (a zero would read as "no fees were charged", which is a claim the
 * broker never made).
 */
export interface PositionClosure {
  positionId: string;
  /** VWAP of the closing deals / the contract's exit spot. Null if unreported. */
  exitPrice: number | null;
  /** Lots reported by the closing deals, or null when unreported. */
  closingVolume: number | null;
  /**
   * True when the BROKER has proven the position is fully settled.
   *
   * REQUIRED, and deliberately separate from `closingVolume`. A contract broker
   * settles all-or-nothing and reports no closing lot size at all, so
   * `closingVolume` is null for every Deriv closure (fabricating one would be a
   * number the broker never sent). A caller that gates on volume coverage alone
   * therefore refuses EVERY contract closure and a settled contract can never be
   * booked — which is exactly the defect this flag closes.
   *
   * `true` means the adapter read the broker's own settlement proof: for Deriv,
   * `is_sold` / `status === 'sold'` on the contract. It is never inferred from a
   * P/L figure or a missing position.
   *
   * For a lot broker this stays `false`, and the volume-coverage rule decides
   * (a partial close must not be booked as the position's final result).
   */
  fullyClosed: boolean;
  grossPnL: number | null;
  commission: number | null;
  swap: number | null;
  netPnL: number;
  /** Execution time of the close, or null when the broker sent none. */
  closedAt: Date | null;
  dealIds: string[];
}

/** Cost of opening an order, as the broker prices it. */
export interface OrderCost {
  /** Account-currency amount the broker would take (Deriv: proposal ask price). */
  cost: number;
  currency: string;
  /** Broker's quoted payout for the contract, when it reports one. */
  payout?: number;
}

/** Server-pushed event streams from the bridge. */
export interface BrokerEventHandlers {
  onPositionOpened?: (p: BrokerPosition) => void | Promise<void>;
  onPositionUpdated?: (p: BrokerPosition) => void | Promise<void>;
  onPositionClosed?: (args: {
    positionId: string;
    investmentId: string | null;
    deal: BrokerDeal | null;
  }) => void | Promise<void>;
  onQuote?: (q: Quote) => void | Promise<void>;
  onConnectionState?: (state: { connected: boolean; state: string }) => void | Promise<void>;
}

export interface BrokerAdapter {
  /**
   * Contract multiplier a stake-denominated broker will use when a request omits
   * one. Exposed so the SIZING path can report the exposure it is opening
   * without duplicating the adapter's default — two copies of "100" is how a
   * notional silently stops matching the broker's.
   */
  readonly stakeMultiplier?: number;
  readonly accountId: string;

  /** Establish streaming + RPC connectivity. Idempotent. */
  connect(handlers: BrokerEventHandlers): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /** One-shot account snapshot. */
  getAccountState(): Promise<BrokerAccountState>;

  /** RPC round-trip in milliseconds — surfaced as terminal latency in admin. */
  ping(): Promise<number | null>;

  getOpenPositions(): Promise<BrokerPosition[]>;
  getDealsSince(since: Date): Promise<BrokerDeal[]>;
  /** 'lots' for MT4/MT5, 'stake' for Deriv contracts. See SizeDenomination. */
  readonly sizeDenomination: SizeDenomination;

  getHistoricalCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote | null>;
  getInstrumentInfo(symbol: string): Promise<InstrumentInfo | null>;

  /** Every instrument the broker currently offers. */
  listInstruments(): Promise<InstrumentInfo[]>;

  /** Whether the broker currently accepts orders for this instrument. */
  isSymbolTradable(symbol: string): Promise<boolean | null>;

  /**
   * What opening this order would cost, from the broker's own quote.
   *
   * Replaces the MT5 `calculateRequiredMargin` pre-trade check: a contract
   * broker prices an order from a proposal (`ask_price`) rather than from lots
   * x margin. Prefer this over any locally computed figure — it is the number
   * the broker would actually take.
   */
  getOrderCost(request: {
    symbol: string;
    direction: 'BUY' | 'SELL';
    stake: number;
    multiplier?: number;
  }): Promise<OrderCost | null>;

  /**
   * Ask the broker terminal to STREAM quotes for a symbol, so
   * `BrokerEventHandlers.onQuote` starts firing for it.
   *
   * This is the difference between a chart that renders once and a chart that
   * moves: a broker streaming connection only delivers prices for symbols it
   * has been told to stream (or that the account holds a position in), so
   * without this call `onQuote` never fires for a symbol the account is merely
   * *watching*.
   *
   * Returns the price the broker reported at subscription time (the call
   * answers with the current quote), or null when there was nothing usable to
   * report yet. Idempotent: subscribing twice costs one upstream subscription.
   */
  subscribeToMarketData(symbol: string): Promise<Quote | null>;

  /** Stop streaming quotes for a symbol. Best-effort — closing the connection also releases it. */
  unsubscribeFromMarketData(symbol: string): Promise<void>;

  placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult>;
  closePosition(positionId: string, volume?: number): Promise<ClosePositionResult>;
}
