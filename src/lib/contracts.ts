/**
 * API + UI contracts shared by client and server.
 *
 * Contains no secrets, so it is safe to import from React components.
 */

/**
 * MANDATORY DISCLAIMER (business directive #2).
 * Every target/expected return figure rendered in the UI or returned by the API
 * must carry this exact label. It is exported as a constant so the wording can
 * never drift between surfaces.
 */
export const TARGET_RETURN_LABEL = 'Target/Indicative — non-guaranteed';

/** Machine-readable mirror of the label for API payloads. */
export const TARGET_RETURN_DISCLAIMER =
  'Target/Indicative — non-guaranteed. Figures are strategy objectives derived from historical broker data, not a promise of future performance. Capital is at risk of loss.';

export const DISCLAIMER_SHORT = 'Target — non-guaranteed';

/** Standard API envelope. Every route returns one of these shapes. */
export type ApiOk<T> = { ok: true; data: T; disclaimer?: string };
export type ApiErr = {
  ok: false;
  error: { code: ApiErrorCode; message: string; details?: unknown };
};
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'KYC_REQUIRED'
  | 'INSUFFICIENT_FUNDS'
  | 'RISK_REJECTED'
  | 'BROKER_UNAVAILABLE'
  | 'PAYMENT_ERROR'
  | 'INTERNAL';

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const CRYPTO_ASSET_META: Record<
  string,
  { symbol: string; label: string; network: string; decimals: number }
> = {
  usdttrc20: { symbol: 'USDT', label: 'Tether USD', network: 'TRON (TRC20)', decimals: 6 },
  usdterc20: { symbol: 'USDT', label: 'Tether USD', network: 'Ethereum (ERC20)', decimals: 6 },
  usdtbsc: { symbol: 'USDT', label: 'Tether USD', network: 'BNB Smart Chain (BEP20)', decimals: 18 },
  usdc: { symbol: 'USDC', label: 'USD Coin', network: 'Ethereum (ERC20)', decimals: 6 },
  btc: { symbol: 'BTC', label: 'Bitcoin', network: 'Bitcoin', decimals: 8 },
  eth: { symbol: 'ETH', label: 'Ethereum', network: 'Ethereum', decimals: 8 },
  ltc: { symbol: 'LTC', label: 'Litecoin', network: 'Litecoin', decimals: 8 },
  trx: { symbol: 'TRX', label: 'TRON', network: 'TRON', decimals: 6 },
  bnb: { symbol: 'BNB', label: 'BNB', network: 'BNB Smart Chain (BEP20)', decimals: 8 },
};

export function assetMeta(currency: string) {
  return (
    CRYPTO_ASSET_META[currency.toLowerCase()] ?? {
      symbol: currency.toUpperCase(),
      label: currency.toUpperCase(),
      network: '—',
      decimals: 8,
    }
  );
}

/** Human labels for payment + investment status enums. */
export const PAYMENT_STATUS_META: Record<
  string,
  { label: string; tone: 'pending' | 'ok' | 'bad' | 'neutral' }
> = {
  PENDING: { label: 'Pending', tone: 'pending' },
  WAITING: { label: 'Awaiting confirmation', tone: 'pending' },
  CONFIRMED: { label: 'Confirmed', tone: 'ok' },
  SENDING: { label: 'Sending', tone: 'pending' },
  FINISHED: { label: 'Finished', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
  REFUNDED: { label: 'Refunded', tone: 'bad' },
};

export const KYC_STATUS_META: Record<
  string,
  { label: string; tone: 'pending' | 'ok' | 'bad' | 'neutral'; blurb: string }
> = {
  NOT_SUBMITTED: {
    label: 'Not submitted',
    tone: 'neutral',
    blurb: 'Submit your identity documents to activate deposits.',
  },
  PENDING: { label: 'Pending review', tone: 'pending', blurb: 'Queued for manual review.' },
  UNDER_REVIEW: { label: 'Under review', tone: 'pending', blurb: 'A compliance officer is reviewing your file.' },
  APPROVED: { label: 'Verified', tone: 'ok', blurb: 'Identity verified.' },
  REJECTED: { label: 'Rejected', tone: 'bad', blurb: 'Your submission was rejected. See the reason below.' },
  ADDITIONAL_INFO_REQUIRED: {
    label: 'Action required',
    tone: 'pending',
    blurb: 'Additional information is required before we can approve your file.',
  },
};

/** Socket.io event names — single source of truth for both ends. */
export const WS_EVENTS = {
  subscribe: 'trading:subscribe',
  unsubscribe: 'trading:unsubscribe',
  positionOpened: 'trade:opened',
  positionUpdated: 'trade:updated',
  positionClosed: 'trade:closed',
  tick: 'price:tick',
  equity: 'account:equity',
  activity: 'bot:activity',
  brokerStatus: 'broker:status',
  /**
   * Platform-wide operating state (kill switch, effective risk limits). Emitted
   * to the `admin` room only — it is an operator signal, not client data.
   */
  systemStatus: 'admin:system_status',
  error: 'server:error',
} as const;

/* ─────────────────────────── market data rooms ─────────────────────────── */

/**
 * Socket room prefix for a watched instrument's live quote feed.
 *
 * Ticks themselves are published namespace-wide (a tick is public,
 * symbol-scoped market data and carries nothing account-specific) — this room is
 * the DEMAND SIGNAL: joining it tells the socket runtime to ask the broker
 * terminal to start streaming that symbol, and leaving it releases the upstream
 * subscription. See `src/server/modules/market/market-stream.service.ts`.
 */
export const MARKET_ROOM_PREFIX = 'market:';

/**
 * Symbols a client may watch: letters, digits and common broker separators.
 *
 * Both cases on purpose. Broker symbols are CASE-SENSITIVE — Deriv's gold is
 * `frxXAUUSD`, and `FRXXAUUSD` is a symbol that does not exist. Upper-casing
 * here (it used to) turned a valid watch request into `InvalidSymbol` at the
 * broker, which surfaced as "no live quote" with nothing pointing at the cause.
 */
export const MARKET_SYMBOL_PATTERN = /^[A-Za-z0-9._#+-]{2,24}$/;

/**
 * Normalise user input to a broker symbol, or null when it is not one.
 *
 * Trims and validates ONLY. It must not change the case: the string is passed
 * to the broker verbatim as the instrument to subscribe to or price.
 */
export function normaliseMarketSymbol(input: string): string | null {
  const symbol = input.trim();
  return MARKET_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

/**
 * Room name for a symbol's live feed. */
export function marketRoom(symbol: string): string {
  return `${MARKET_ROOM_PREFIX}${symbol}`;
}

/**
 * How many symbols ONE socket may watch at once.
 *
 * Lives here, not in the socket server, because the browser has to obey the same
 * number: a watchlist that joins more rooms than this gets its extras refused
 * with a `server:error`, and the two sides drifting apart on the constant is
 * exactly how a UI ends up showing "no live quote" for a symbol it is entitled
 * to. Each watched symbol costs one upstream broker subscription, so this is the
 * per-connection share of `MAX_STREAMED_SYMBOLS` in the market-stream service.
 */
export const MAX_MARKET_ROOMS_PER_SOCKET = 12;

/** Symbol carried by a market room name, or null when `room` is not one. */
export function parseMarketRoom(room: string): string | null {
  if (!room.startsWith(MARKET_ROOM_PREFIX)) return null;
  return normaliseMarketSymbol(room.slice(MARKET_ROOM_PREFIX.length));
}
