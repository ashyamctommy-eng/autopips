/**
 * Broker abstraction contract.
 *
 * Everything above this boundary (bot engine, accounting, API, UI) talks to
 * these types only. MetaApi is an implementation detail behind
 * `BrokerAdapter`; swapping to another MT4/MT5 bridge must not touch callers.
 *
 * ZERO SIMULATION: an implementation of this interface may only return data it
 * actually received from the broker bridge. There is no `mockMode`.
 */

export type BrokerEnvironment = 'LIVE' | 'DEMO';
export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface BrokerAccountState {
  /** MetaApi account id (uuid) or the broker's own id when unavailable. */
  accountId: string;
  brokerName: string;
  environment: BrokerEnvironment;
  /** e.g. "***-9012" — never the full login. */
  maskedAccount: string;
  /** Broker-reported account currency, e.g. "USD". */
  currency: string;
  balance: number;
  equity: number;
  freeMargin: number;
  margin: number;
  leverage: number;
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
  volume: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Broker-reported unrealised P/L in account currency. */
  unrealizedPnL: number;
  commission: number;
  swap: number;
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
  volume: number;
  price: number;
  /** Signed broker profit for the deal, before commission/swap. */
  grossPnL: number;
  commission: number;
  swap: number;
  /** grossPnL + commission + swap, as reported by the broker. */
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

export interface SymbolSpec {
  symbol: string;
  digits: number;
  /** Minimum volume step, e.g. 0.01 */
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  contractSize: number;
  /** Account-currency value of one point of price for 1 lot. */
  tickValue: number;
}

export interface PlaceOrderRequest {
  symbol: string;
  direction: 'BUY' | 'SELL';
  volume: number;
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
  volume?: number;
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

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
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
  getHistoricalCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote | null>;
  getSymbolSpec(symbol: string): Promise<SymbolSpec | null>;

  /**
   * Ask the broker terminal to STREAM quotes for a symbol, so
   * `BrokerEventHandlers.onQuote` starts firing for it.
   *
   * This is the difference between a chart that renders once and a chart that
   * moves: a MetaApi streaming connection only delivers prices for symbols it
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
