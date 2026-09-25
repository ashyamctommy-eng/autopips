import { ApiError } from '@/lib/http';
import { maskAccount } from '@/lib/crypto/credential-cipher';
import {
  DERIV_PUBLIC_WS_URL,
  DERIV_REST_BASE_URL,
  isDemoAccountSocketUrl,
} from '@/server/modules/broker/deriv.endpoints';
import { getSettingNumber } from '@/server/modules/settings/settings.service';

import {
  DERIV_DEFAULT_URL,
  DerivClient,
  type DerivErrorPayload,
} from './deriv.client';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerDeal,
  BrokerEnvironment,
  BrokerEventHandlers,
  BrokerPosition,
  Candle,
  ClosePositionResult,
  InstrumentInfo,
  OrderCost,
  PlaceOrderRequest,
  PlaceOrderResult,
  PositionClosure,
  Quote,
  SizeDenomination,
} from './broker.types';

/**
 * DERIV BROKER ADAPTER.
 *
 * One implementation of `BrokerAdapter` over Deriv's WebSocket API — the
 * replacement for the removed MetaApi/MT4-MT5 bridge. Everything Deriv-specific about
 * this platform stops here; the bot engine, accounting, API and UI only ever see
 * `broker.types.ts`.
 *
 * WHAT DERIV ACTUALLY IS (and why this adapter is shaped the way it is)
 *   A Deriv "position" is a CONTRACT: a stake (the buy price), a multiplier, an
 *   entry spot and an exit spot. There are no lots, no contract size, no tick
 *   value, no free margin, no swap and no separate commission. So:
 *
 *   • `sizeDenomination` is 'stake' — the platform must size orders in account
 *     currency, not lots. `placeOrder` REFUSES a request that offers only lots:
 *     converting lots to a stake would mean inventing a contract size the broker
 *     never published, and that number would then move real money.
 *   • every MT5-only field is `null`, never 0. `freeMargin: 0` would read as
 *     "you have no margin left"; `null` reads as "Deriv does not report margin",
 *     which is the truth.
 *   • a single-price instrument (Deriv's synthetic indices quote one number)
 *     yields `bid`/`ask` null plus `quote` set, rather than a fabricated spread.
 *
 * MARKET DATA needs no token: candles, quotes and symbol metadata are public.
 * Trading, balance and portfolio require an authorised token; without one the
 * adapter boots, streams prices, and fails every authenticated call with a
 * clear ApiError instead of pretending.
 *
 * TIMEFRAMES: Deriv's granularity is seconds and its allowed set covers our
 * whole UI (1m/5m/15m/30m/1h/4h/1d). The mapping is explicit so a timeframe the
 * broker cannot serve is rejected here rather than silently bucketed wrong.
 */

/**
 * Platform risk controls that only exist where a stake does.
 *
 * The stake cap and the payout floor are enforced HERE, in the pricing path,
 * because this is the only place where the stake and the proposal are both
 * known: the lot allocator upstream produces lots, and a contract broker has
 * none. A violation is a REFUSAL, never a silent clamp — shrinking a stake to
 * fit a cap would change the trade the operator asked for.
 */
function assertStakeWithinPlatformCap(stake: number): void {
  const cap = getSettingNumber('risk.max_stake_usd');
  if (cap > 0 && stake > cap) {
    throw ApiError.badRequest(
      `Stake ${stake} exceeds the platform cap of ${cap} (Admin → Bot control).`,
    );
  }
}

function assertPayoutAboveFloor(cost: number, payout: number | null): void {
  const floor = getSettingNumber('risk.min_payout_percentage');
  if (floor <= 0) return;
  if (payout === null) {
    throw ApiError.badRequest(
      'This contract quotes no payout, so the platform minimum payout percentage cannot be evaluated. ' +
        'Set the payout floor to 0 or use a contract type that quotes one.',
    );
  }
  if (cost <= 0) return;
  const percentage = (payout / cost) * 100;
  if (percentage < floor) {
    throw ApiError.badRequest(
      `Quoted payout ${percentage.toFixed(2)}% of cost is below the platform floor of ${floor}%.`,
    );
  }
}

/**
 * Timeframe → Deriv granularity (seconds). Mirrors the candles route's list.
 * Exported because the PUBLIC market-data client reads the same vocabulary: one
 * list, so a timeframe the route accepts can never be one the broker refuses.
 */
export const GRANULARITY_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

/**
 * Deriv `candles` payload → the platform's Candle, dropping anything unusable.
 *
 * Pure and exported so the public market-data client maps identically: a bar the
 * authorised socket would refuse cannot slip in through the public one.
 *
 * No volume is ever produced. Deriv's candle payload carries none, and a
 * synthesised tick count would be a made-up number on a chart that shows money.
 */
export function mapDerivCandles(payload: unknown): { candles: Candle[]; skipped: number } {
  const candles: Candle[] = [];
  let skipped = 0;

  for (const entry of asArray(payload)) {
    const raw = asRecord(entry);
    const time = epochSeconds(raw?.epoch);
    if (
      !raw ||
      time === null ||
      !isFiniteNumber(raw.open) ||
      !isFiniteNumber(raw.high) ||
      !isFiniteNumber(raw.low) ||
      !isFiniteNumber(raw.close)
    ) {
      skipped += 1;
      continue;
    }
    candles.push({ time, open: raw.open, high: raw.high, low: raw.low, close: raw.close });
  }

  return { candles: candles.sort((a, b) => a.time - b.time), skipped };
}

/**
 * Deriv `active_symbols` payload → instrument metadata.
 *
 * The CURRENT surface names the fields `underlying_symbol` /
 * `underlying_symbol_name`; the retired one used `symbol` / `display_name`. The
 * old names are still accepted as a fallback so a payload from either surface is
 * read correctly — and so an empty instrument list can only ever mean "the
 * broker sent none", never "we looked for the wrong key". That distinction cost
 * a chart its instrument picker once.
 *
 * Exported because the PUBLIC market-data client reads the same list: one
 * mapper, so the console's symbol picker and the chart's cannot disagree.
 */
export function mapDerivActiveSymbols(payload: unknown): InstrumentInfo[] {
  const instruments: InstrumentInfo[] = [];

  for (const entry of asArray(payload)) {
    const raw = asRecord(entry);
    if (!raw) continue;

    const symbol =
      typeof raw.underlying_symbol === 'string'
        ? raw.underlying_symbol
        : typeof raw.symbol === 'string'
          ? raw.symbol
          : null;
    if (!symbol) continue;

    const displayName =
      typeof raw.underlying_symbol_name === 'string'
        ? raw.underlying_symbol_name
        : typeof raw.display_name === 'string'
          ? raw.display_name
          : symbol;
    const pipSize = isFiniteNumber(raw.pip_size)
      ? raw.pip_size
      : isFiniteNumber(raw.pip)
        ? raw.pip
        : 0;

    instruments.push({
      symbol,
      displayName,
      market: typeof raw.market === 'string' ? raw.market : 'unknown',
      submarket: typeof raw.submarket === 'string' ? raw.submarket : 'unknown',
      pipSize,
      // Tradable = the venue is open AND the instrument is not suspended. The
      // previous `||` made a suspended instrument on an open venue look tradable.
      isTradable: raw.exchange_is_open === 1 && raw.is_trading_suspended !== 1,
    });
  }

  return instruments;
}

/** Deriv's default multiplier when neither the order nor the config sets one. */
export const DEFAULT_DERIV_MULTIPLIER = 100;

/** Deriv multipliers are quoted per contract type; these are the two we submit. */
const MULTUP = 'MULTUP';
const MULTDOWN = 'MULTDOWN';

/** Deriv caps `ticks_history` count; larger requests are split by the API. */
const MAX_CANDLES = 5_000;

/** Ceiling for the REST OTP exchange, when the environment sets nothing. */
const DEFAULT_REST_TIMEOUT_MS = 15_000;

export interface DerivBrokerAdapterConfig {
  /** Deriv TRADING ACCOUNT id (e.g. "DOT94640065"), not the Deriv user number. */
  loginId: string | null;
  appId: string;
  /** Personal Access Token (`pat_…`). Null = market data only. */
  token: string | null;
  /** Public market-data socket, used when there is no token to authenticate. */
  url?: string;
  /** REST base for the account side — the OTP exchange that authenticates a socket. */
  restUrl?: string;
  /** Contract multiplier for MULTUP/MULTDOWN. Defaults to 100. */
  multiplier?: number;
  /** Account currency; when absent it is read from the authorised account. */
  currency?: string | null;
  connectTimeoutMs?: number;
}

interface AuthorizedAccount {
  loginId: string;
  currency: string;
  isVirtual: boolean;
  scopes: string[];
  balance: number | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Deriv timestamps are epoch SECONDS; the platform's Candle.time is too. */
function epochSeconds(value: unknown): number | null {
  if (isFiniteNumber(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

export class DerivBrokerAdapter implements BrokerAdapter {
  public readonly accountId: string;
  readonly sizeDenomination: SizeDenomination = 'stake';

  /** The multiplier this adapter opens contracts with (config, else Deriv's default). */
  readonly stakeMultiplier: number;

  private readonly config: DerivBrokerAdapterConfig;
  private client: DerivClient | null = null;
  private handlers: BrokerEventHandlers = {};

  private authorized: AuthorizedAccount | null = null;
  /** Whether the OTP-issued socket is for a demo account (from its URL path). */
  private socketIsVirtual: boolean | null = null;
  private instruments: Map<string, InstrumentInfo> | null = null;
  private instrumentsCachedAt = 0;

  /** Symbols we currently stream quotes for, with Deriv's subscription ids. */
  private readonly tickSubscriptions = new Map<string, { subscriptionId: string | null }>();
  /** Last portfolio snapshot, for the position-delta diff. */
  private portfolio = new Map<string, BrokerPosition>();
  private balanceSubscribed = false;
  private lastBalance: number | null = null;

  /** Deriv's active_symbols cache TTL — instrument metadata changes rarely. */
  private static readonly INSTRUMENT_CACHE_TTL_MS = 300_000;

  constructor(config: DerivBrokerAdapterConfig) {
    this.config = config;
    this.stakeMultiplier = config.multiplier ?? DEFAULT_DERIV_MULTIPLIER;
    this.accountId = config.loginId?.trim() || `deriv:${config.appId}`;
  }

  /* ───────────────────────────── connection ────────────────────────────── */

  async connect(handlers: BrokerEventHandlers): Promise<void> {
    this.handlers = handlers;
    await this.ensureSocket();
    await this.authorize();
    await this.subscribeAccountStreams();
    this.emitConnectionState(true);
  }

  async disconnect(): Promise<void> {
    this.tickSubscriptions.clear();
    this.balanceSubscribed = false;
    this.portfolio.clear();
    this.authorized = null;
    this.lastBalance = null;
    const client = this.client;
    this.client = null;
    client?.close();
  }

  isConnected(): boolean {
    return this.client?.isConnected() === true;
  }

  private async clientOrConnect(): Promise<DerivClient> {
    const client = this.client;
    if (!client) {
      throw ApiError.brokerUnavailable('Deriv adapter is not connected.');
    }
    if (!client.isConnected()) {
      // A reconnect drops Deriv-side subscriptions (and, with OTP, the account
      // authentication itself): re-open, re-authenticate and re-subscribe so a
      // caller never sees a half-dead connection.
      this.client = null;
      this.authorized = null;
      await this.ensureSocket();
      await this.authorize();
      await this.subscribeAccountStreams();
      this.emitConnectionState(true);
      return this.client!;
    }
    return client;
  }

  /**
   * The socket this adapter talks on, opened if needed.
   *
   * WITH a token the socket must be the one Deriv issues for THAT account: an
   * OTP is obtained over REST and the returned URL is used verbatim. Deriv's
   * older `authorize` message is not part of that surface — authentication now
   * happens when the socket is issued, which is also why the account id is
   * validated by Deriv itself rather than by a post-hoc comparison.
   *
   * WITHOUT a token there is nothing to authenticate, so the public
   * market-data socket is used and every account/trading call refuses.
   */
  private async ensureSocket(): Promise<DerivClient> {
    if (this.client?.isConnected()) return this.client;

    const issued = this.config.token ? await this.requestAccountSocket() : null;
    this.socketIsVirtual = issued?.isVirtual ?? null;

    this.client = new DerivClient({
      appId: this.config.appId,
      url: issued?.url ?? this.config.url ?? DERIV_PUBLIC_WS_URL,
      ...(this.config.connectTimeoutMs ? { connectTimeoutMs: this.config.connectTimeoutMs } : {}),
      onClose: (reason) => {
        // Subscriptions die with the socket; drop our bookkeeping so the next
        // request re-establishes them instead of believing they are live.
        this.tickSubscriptions.clear();
        this.balanceSubscribed = false;
        this.portfolio.clear();
        void this.handlers.onConnectionState?.({
          connected: false,
          state: `DISCONNECTED (${reason})`,
        });
      },
    });

    await this.client.connect();
    return this.client;
  }

  /**
   * REST: exchange the Personal Access Token for a one-time, account-scoped
   * socket URL (`wss://api.derivws.com/trading/v1/options/ws/demo?otp=…`).
   *
   * The OTP endpoint requires the `trade` scope, so a successful exchange IS the
   * capability check — there is no scope list to read back, and inventing one
   * would be a claim about the token that nothing verified.
   */
  private async requestAccountSocket(): Promise<{ url: string; isVirtual: boolean }> {
    const token = this.config.token;
    const loginId = this.config.loginId?.trim() ?? '';

    if (!token) throw ApiError.brokerUnavailable('No Deriv API token is configured.');
    if (!loginId) {
      throw ApiError.brokerUnavailable(
        'A Deriv connection needs the trading account id (e.g. DOT94640065 or ROT92685247) — the Deriv user number is not an account.',
      );
    }

    const base = (this.config.restUrl ?? DERIV_REST_BASE_URL).replace(/\/+$/, '');
    const timeout = this.config.connectTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS;

    let response: Response;
    try {
      response = await fetch(`${base}/trading/v1/options/accounts/${encodeURIComponent(loginId)}/otp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          // Required when authenticating with a PAT; without it Deriv cannot
          // tell which application is asking.
          'Deriv-App-ID': this.config.appId,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw ApiError.brokerUnavailable(
        `Could not reach Deriv at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      data?: { url?: unknown };
      errors?: Array<{ message?: unknown; code?: unknown }>;
    } | null;

    if (!response.ok) {
      // Deriv's OWN words: "Invalid or missing authentication credentials"
      // (token) and "Invalid account ID format" (login id) are different
      // problems, and a single generic sentence would hide which one it is.
      const detail =
        Array.isArray(body?.errors) && body.errors.length > 0
          ? body.errors
              .map((error) => (typeof error?.message === 'string' ? error.message : null))
              .filter(Boolean)
              .join('; ')
          : null;
      throw ApiError.brokerUnavailable(
        `Deriv refused a session for ${maskAccount(loginId)} (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
      );
    }

    const raw = typeof body?.data?.url === 'string' ? body.data.url : null;
    if (!raw) {
      throw ApiError.brokerUnavailable('Deriv returned no WebSocket URL for that account.');
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw ApiError.brokerUnavailable('Deriv returned an unparseable WebSocket URL; refusing it.');
    }
    if (parsed.protocol !== 'wss:') {
      // A credential is carried in that URL: an unencrypted socket would leak it.
      throw ApiError.brokerUnavailable('Deriv returned a non-TLS WebSocket URL; refusing it.');
    }

    return { url: raw, isVirtual: isDemoAccountSocketUrl(raw) };
  }

  private emitConnectionState(connected: boolean): void {
    void this.handlers.onConnectionState?.({
      connected,
      state: connected ? (this.authorized ? 'AUTHORIZED' : 'CONNECTED') : 'DISCONNECTED',
    });
  }

  /* ─────────────────────────────── auth ───────────────────────────────── */

  private async authorize(): Promise<AuthorizedAccount | null> {
    if (!this.config.token) return null;
    if (this.authorized) return this.authorized;

    const client = await this.ensureSocket();
    const loginId = this.config.loginId?.trim() ?? '';

    // The first call on an OTP-issued socket is also the proof it is live: a
    // socket that was not properly issued answers with an error.
    const response = await client.request<{ balance?: Record<string, unknown> }>(
      { balance: 1 },
      'balance',
    );
    const raw = asRecord(response.balance);

    const reported = typeof raw?.loginid === 'string' ? raw.loginid : null;
    if (reported && reported !== loginId) {
      // Trading the wrong account is worse than not trading: refuse rather than
      // reconcile.
      throw ApiError.brokerUnavailable(
        `Deriv answered for ${maskAccount(reported)}, not the configured account.`,
      );
    }

    this.authorized = {
      loginId: reported ?? loginId,
      currency: typeof raw?.currency === 'string' ? raw.currency : (this.config.currency ?? 'USD'),
      isVirtual: this.socketIsVirtual === true,
      // Not reported by this surface: the OTP exchange already required `trade`.
      scopes: [],
      balance: raw && isFiniteNumber(raw.balance) ? raw.balance : null,
    };
    this.lastBalance = this.authorized.balance;

    console.info(
      `[deriv.adapter] authenticated ${maskAccount(this.authorized.loginId)} (${this.authorized.isVirtual ? 'DEMO' : 'LIVE'}) via an account OTP socket`,
    );
    return this.authorized;
  }

  /**
   * Trading capability, ensured rather than assumed.
   *
   * It AUTHENTICATES first: `authorize()` is the OTP exchange, so on a cold
   * adapter the capability question cannot be answered without it. Answering "no
   * token" for a configured connection would be wrong, and answering "allowed"
   * without a live session would be a lie.
   */
  private async requireTradingAuth(): Promise<AuthorizedAccount> {
    const authorized = await this.authorize();
    if (!authorized) {
      throw ApiError.brokerUnavailable(
        'Deriv is not authenticated — set DERIV_API_TOKEN (or the admin console setting) to trade.',
      );
    }
    /*
     * No scope check here on purpose. The OTP exchange this adapter now uses is
     * the trading endpoint and requires the `trade` scope: a socket exists only
     * if the token already passed that gate. Re-reading a scope list that the
     * new surface does not return would mean inventing one.
     */
    return authorized;
  }

  /** `balance` and `portfolio` streams, subscribed once per connection. */
  private async subscribeAccountStreams(): Promise<void> {
    if (!this.authorized) return;
    const client = await this.clientOrConnect();

    if (!this.balanceSubscribed) {
      this.balanceSubscribed = true;
      await client.subscribe({ balance: 1 }, 'balance', (message) => {
        const balance = asRecord(message.balance);
        if (balance && isFiniteNumber(balance.balance)) {
          this.lastBalance = balance.balance;
          if (this.authorized) this.authorized.balance = balance.balance;
        }
      });
    }

    /*
     * PORTFOLIO IS NOT SUBSCRIBABLE on this surface.
     *
     * `{ portfolio: 1, subscribe: 1 }` is rejected outright —
     * "InputValidationFailed: Properties not allowed: subscribe" — while the
     * plain request is accepted, so positions are POLLED instead of pushed:
     * `getOpenPositions()` feeds the same delta detector on every read, and the
     * broker-sync worker performs those reads on BROKER_SYNC_INTERVAL.
     *
     * The alternative (subscribing anyway and swallowing the error) would leave
     * positionOpened/Closed events silently dead while the logs looked clean.
     */
  }

  private handlePortfolio(message: Record<string, unknown>): void {
    const raw = asRecord(message.portfolio);
    const contracts = raw ? asArray(raw.contracts) : [];
    const next = new Map<string, BrokerPosition>();
    for (const contract of contracts) {
      const position = this.mapContract(contract);
      if (position) next.set(position.positionId, position);
    }

    for (const [id, position] of next) {
      const previous = this.portfolio.get(id);
      if (!previous) void this.handlers.onPositionOpened?.(position);
      else if (previous.currentPrice !== position.currentPrice) {
        void this.handlers.onPositionUpdated?.(position);
      }
    }
    for (const [id, previous] of this.portfolio) {
      if (next.has(id)) continue;
      // Gone from the portfolio: closed or expired. The settlement detail is
      // pulled by the sync (proposal_open_contract), exactly as before.
      void this.handlers.onPositionClosed?.({
        positionId: id,
        investmentId: previous.investmentId,
        deal: null,
      });
    }

    this.portfolio = next;
  }

  /* ───────────────────────────── account state ─────────────────────────── */

  async getAccountState(): Promise<BrokerAccountState> {
    const authorized = this.config.token ? await this.authorize() : null;
    const client = await this.clientOrConnect();

    let balance = this.lastBalance ?? authorized?.balance ?? null;
    if (balance === null) {
      const response = await client.request<{ balance?: Record<string, unknown> }>(
        { balance: 1 },
        'balance',
      );
      const raw = asRecord(response.balance);
      balance = raw && isFiniteNumber(raw.balance) ? raw.balance : null;
      this.lastBalance = balance;
    }

    // Equity = balance + broker-reported unrealised profit, both real numbers.
    // Without a portfolio read there is no equity to report, so it stays null.
    let equity: number | null = balance;
    if (authorized) {
      const positions = await this.getOpenPositions();
      const floating = positions.reduce((total, position) => total + position.unrealizedPnL, 0);
      equity = balance === null ? null : Number((balance + floating).toFixed(2));
    }

    const environment: BrokerEnvironment = authorized?.isVirtual ? 'DEMO' : 'LIVE';
    const loginId = authorized?.loginId ?? this.config.loginId ?? this.accountId;

    return {
      accountId: loginId,
      brokerName: 'Deriv',
      environment,
      maskedAccount: maskAccount(loginId),
      currency: authorized?.currency ?? this.config.currency ?? 'USD',
      balance: balance ?? 0,
      equity,
      // Deriv reports none of these; null means "not reported", not "zero".
      freeMargin: null,
      margin: null,
      leverage: null,
      isTradingEnabled:
        authorized !== null && authorized.scopes.includes('trade') && this.isConnected(),
      status: this.isConnected() ? 'CONNECTED' : 'DISCONNECTED',
      rawState: authorized ? 'AUTHORIZED' : 'CONNECTED',
      updatedAt: new Date(),
    };
  }

  async ping(): Promise<number | null> {
    try {
      const client = await this.clientOrConnect();
      const startedAt = Date.now();
      await client.request({ ping: 1 }, 'ping');
      return Date.now() - startedAt;
    } catch {
      return null;
    }
  }

  /* ─────────────────────────────── symbols ────────────────────────────── */

  private async loadInstruments(): Promise<Map<string, InstrumentInfo>> {
    const fresh =
      this.instruments !== null &&
      Date.now() - this.instrumentsCachedAt < DerivBrokerAdapter.INSTRUMENT_CACHE_TTL_MS;
    if (fresh) return this.instruments!;

    const client = await this.clientOrConnect();
    const response = await client.request<{ active_symbols?: unknown }>(
      { active_symbols: 'brief' },
      'active_symbols',
    );

    const map = new Map<string, InstrumentInfo>();
    for (const instrument of mapDerivActiveSymbols(response.active_symbols)) {
      map.set(instrument.symbol, instrument);
    }

    this.instruments = map;
    this.instrumentsCachedAt = Date.now();
    return map;
  }

  async getInstrumentInfo(symbol: string): Promise<InstrumentInfo | null> {
    const instruments = await this.loadInstruments();
    return instruments.get(symbol) ?? null;
  }

  /** Every instrument the broker offers, sorted by symbol. */
  async listInstruments(): Promise<InstrumentInfo[]> {
    const instruments = await this.loadInstruments();
    return Array.from(instruments.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async isSymbolTradable(symbol: string): Promise<boolean | null> {
    const info = await this.getInstrumentInfo(symbol);
    return info ? info.isTradable : null;
  }

  /* ───────────────────────────── market data ──────────────────────────── */

  async getHistoricalCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const granularity = GRANULARITY_SECONDS[timeframe];
    if (!granularity) {
      throw ApiError.badRequest(`Deriv cannot serve the ${timeframe} timeframe.`);
    }

    const client = await this.clientOrConnect();
    const limit = Math.max(1, Math.min(Math.trunc(count), MAX_CANDLES));

    const response = await client.request<{ candles?: unknown }>(
      {
        ticks_history: symbol,
        style: 'candles',
        granularity,
        count: limit,
        end: 'latest',
      },
      `ticks_history(${symbol} ${timeframe})`,
    );

    const { candles, skipped } = mapDerivCandles(response.candles);
    if (skipped > 0) {
      console.warn(
        `[deriv.adapter] ${skipped} candle(s) for ${symbol} ${timeframe} had unusable fields and were dropped.`,
      );
    }

    return candles;
  }

  /** One-sided ticks (Deriv synthetics quote a single price) are valid here. */
  private toQuote(symbol: string, tick: Record<string, unknown>): Quote | null {
    const time = epochSeconds(tick.epoch);
    if (time === null) return null;

    const bid = isFiniteNumber(tick.bid) ? tick.bid : null;
    const ask = isFiniteNumber(tick.ask) ? tick.ask : null;
    const quote = isFiniteNumber(tick.quote) ? tick.quote : null;
    if (bid === null && ask === null && quote === null) return null;

    return { symbol: typeof tick.symbol === 'string' ? tick.symbol : symbol, bid, ask, quote, time };
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    const client = await this.clientOrConnect();
    const response = await client.request<{ tick?: unknown }>({ ticks: symbol }, `ticks(${symbol})`);
    const tick = asRecord(response.tick);
    return tick ? this.toQuote(symbol, tick) : null;
  }

  async subscribeToMarketData(symbol: string): Promise<Quote | null> {
    const client = await this.clientOrConnect();

    const existing = this.tickSubscriptions.get(symbol);
    if (existing) {
      // Already streaming: still answer with a current price so a newly
      // interested chart is not left blank until the next terminal push.
      return this.getQuote(symbol);
    }

    const { subscriptionId, first } = await client.subscribe(
      { ticks: symbol },
      `ticks(${symbol})`,
      (message) => {
        const tick = asRecord(message.tick);
        if (!tick) return;
        const quote = this.toQuote(symbol, tick);
        if (quote) void this.handlers.onQuote?.(quote);
      },
      (error: DerivErrorPayload) => {
        // A dropped stream (e.g. symbol trading suspended) must not silently
        // look like a quiet market.
        console.warn(`[deriv.adapter] tick stream for ${symbol} ended: ${error.code} ${error.message}`);
        this.tickSubscriptions.delete(symbol);
      },
    );

    this.tickSubscriptions.set(symbol, { subscriptionId });

    const tick = asRecord(first.tick);
    return tick ? this.toQuote(symbol, tick) : null;
  }

  async unsubscribeFromMarketData(symbol: string): Promise<void> {
    const subscription = this.tickSubscriptions.get(symbol);
    this.tickSubscriptions.delete(symbol);
    if (!subscription?.subscriptionId) return;
    await this.client?.forget(subscription.subscriptionId);
  }

  /* ─────────────────────────────── positions ──────────────────────────── */

  /** Map a Deriv contract (portfolio or proposal_open_contract) to a position. */
  private mapContract(value: unknown): BrokerPosition | null {
    const raw = asRecord(value);
    if (!raw) return null;

    const contractId = raw.contract_id;
    const id = isFiniteNumber(contractId) ? String(contractId) : null;
    const symbol = typeof raw.symbol === 'string' ? raw.symbol : null;
    if (!id || !symbol) return null;

    const contractType = typeof raw.contract_type === 'string' ? raw.contract_type : '';
    const buyPrice = isFiniteNumber(raw.buy_price) ? raw.buy_price : null;
    const entry = isFiniteNumber(raw.entry_spot)
      ? raw.entry_spot
      : isFiniteNumber(raw.entry_tick)
        ? raw.entry_tick
        : null;
    const current = isFiniteNumber(raw.current_spot)
      ? raw.current_spot
      : isFiniteNumber(raw.current_spot_time)
        ? null
        : null;
    const openedAtSeconds = epochSeconds(raw.date_start) ?? epochSeconds(raw.purchase_time);

    return {
      positionId: id,
      instrument: symbol,
      direction: contractType === MULTUP || contractType === 'CALL' ? 'BUY' : 'SELL',
      // Deriv reports no lot size, and stake is not a lot. Both stay explicit.
      volume: null,
      stakeUsd: buyPrice,
      multiplier: isFiniteNumber(raw.multiplier) ? raw.multiplier : null,
      entryPrice: entry ?? 0,
      currentPrice: current ?? entry ?? 0,
      stopLoss: isFiniteNumber(raw.stop_loss) ? raw.stop_loss : null,
      takeProfit: isFiniteNumber(raw.take_profit) ? raw.take_profit : null,
      unrealizedPnL: isFiniteNumber(raw.profit) ? raw.profit : 0,
      // Deriv reports net profit only — no separate commission or swap.
      commission: null,
      swap: null,
      comment: null,
      openedAt: openedAtSeconds ? new Date(openedAtSeconds * 1000) : new Date(0),
      investmentId: null,
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const authorized = this.config.token ? await this.authorize() : null;
    if (!authorized) return [];

    const client = await this.clientOrConnect();
    const response = await client.request<{ portfolio?: Record<string, unknown> }>(
      { portfolio: 1 },
      'portfolio',
    );
    const contracts = asArray(asRecord(response.portfolio)?.contracts);

    const positions: BrokerPosition[] = [];
    for (const contract of contracts) {
      const position = this.mapContract(contract);
      if (position) positions.push(position);
    }

    // Feed the delta detector the snapshot we just read: this surface does not
    // push portfolio updates, so the poll is what keeps onPositionOpened/
    // Updated/Closed honest for anything watching the socket.
    this.handlePortfolio({ portfolio: { contracts } });

    return positions;
  }

  async getDealsSince(since: Date): Promise<BrokerDeal[]> {
    const authorized = this.config.token ? await this.authorize() : null;
    if (!authorized) return [];

    const client = await this.clientOrConnect();
    const response = await client.request<{ profit_table?: Record<string, unknown> }>(
      {
        profit_table: 1,
        description: 1,
        limit: 100,
        date_from: Math.floor(since.getTime() / 1000),
      },
      'profit_table',
    );

    const deals: BrokerDeal[] = [];
    for (const entry of asArray(asRecord(response.profit_table)?.transactions)) {
      const raw = asRecord(entry);
      if (!raw) continue;

      const contractId = raw.contract_id;
      const id = isFiniteNumber(contractId)
        ? String(contractId)
        : typeof raw.transaction_id === 'number'
          ? String(raw.transaction_id)
          : null;
      const symbol = typeof raw.symbol === 'string' ? raw.symbol : null;
      const profit = isFiniteNumber(raw.profit) ? raw.profit : null;
      const executedAt = epochSeconds(raw.purchase_time) ?? epochSeconds(raw.sell_time);
      if (!id || !symbol || profit === null || executedAt === null) continue;

      const contractType = typeof raw.contract_type === 'string' ? raw.contract_type : '';
      const buyPrice = isFiniteNumber(raw.buy_price) ? raw.buy_price : null;

      deals.push({
        dealId: id,
        positionId: id,
        instrument: symbol,
        direction: contractType === MULTUP || contractType === 'CALL' ? 'BUY' : 'SELL',
        volume: null,
        price: buyPrice ?? 0,
        // Deriv publishes a single net profit figure for a settled contract.
        grossPnL: null,
        commission: null,
        swap: null,
        netPnL: profit,
        executedAt: new Date(executedAt * 1000),
        comment: typeof raw.shortcode === 'string' ? raw.shortcode : null,
      });
    }

    return deals.sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
  }

  async getPositionClosure(positionId: string): Promise<PositionClosure | null> {
    const authorized = this.config.token ? await this.authorize() : null;
    if (!authorized) return null;

    const client = await this.clientOrConnect();
    const contractId = Number(positionId);
    if (!Number.isInteger(contractId)) return null;

    const response = await client.request<{ proposal_open_contract?: Record<string, unknown> }>(
      { proposal_open_contract: 1, contract_id: contractId },
      `proposal_open_contract(${positionId})`,
    );
    const raw = asRecord(response.proposal_open_contract);
    if (!raw) return null;

    const isSold = raw.is_sold === 1 || raw.is_sold === true || raw.status === 'sold';
    const profit = isFiniteNumber(raw.profit) ? raw.profit : null;
    if (!isSold || profit === null) return null;

    const exitSpot = isFiniteNumber(raw.exit_tick)
      ? raw.exit_tick
      : isFiniteNumber(raw.sell_spot)
        ? raw.sell_spot
        : null;
    const closedAtSeconds = epochSeconds(raw.sell_time) ?? epochSeconds(raw.exit_tick_time);

    return {
      positionId,
      exitPrice: exitSpot,
      closingVolume: null,
      // Deriv's settled profit is net; it does not itemise the costs.
      grossPnL: null,
      commission: null,
      swap: null,
      netPnL: profit,
      closedAt: closedAtSeconds ? new Date(closedAtSeconds * 1000) : null,
      dealIds: [],
    };
  }

  /* ────────────────────────────── execution ───────────────────────────── */

  async getOrderCost(request: {
    symbol: string;
    direction: 'BUY' | 'SELL';
    stake: number;
    multiplier?: number;
  }): Promise<OrderCost | null> {
    const authorized = await this.requireTradingAuth();
    const client = await this.clientOrConnect();

    const response = await client.request<{ proposal?: Record<string, unknown> }>(
      {
        proposal: 1,
        amount: request.stake,
        basis: 'stake',
        contract_type: request.direction === 'BUY' ? MULTUP : MULTDOWN,
        currency: authorized.currency,
        symbol: request.symbol,
        multiplier: request.multiplier ?? this.config.multiplier ?? 100,
      },
      `proposal(${request.symbol})`,
    );

    const proposal = asRecord(response.proposal);
    if (!proposal) return null;
    const cost = isFiniteNumber(proposal.ask_price) ? proposal.ask_price : null;
    if (cost === null) return null;
    const payout = isFiniteNumber(proposal.payout) ? proposal.payout : null;

    assertStakeWithinPlatformCap(request.stake);
    assertPayoutAboveFloor(cost, payout);

    return {
      cost,
      currency: authorized.currency,
      ...(payout === null ? {} : { payout }),
    };
  }

  /**
   * Open a Deriv contract (MULTUP for BUY, MULTDOWN for SELL).
   *
   * A lot-denominated request is REFUSED rather than converted: the platform
   * would have to invent a contract size to turn 0.10 lots into a stake, and
   * that invented number would decide how much real money is put at risk.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const stake = isFiniteNumber(request.stake) ? request.stake : null;
    if (stake === null || stake <= 0) {
      return {
        ok: false,
        errorCode: 'STAKE_REQUIRED',
        brokerMessage:
          'Deriv orders are denominated in a stake (account currency), not lots. ' +
          'This request supplied no stake, and converting lots would require a contract ' +
          'size Deriv does not publish.',
      };
    }

    const authorized = await this.requireTradingAuth();
    const client = await this.clientOrConnect();
    const multiplier = request.multiplier ?? this.stakeMultiplier;

    const proposalResponse = await client.request<{ proposal?: Record<string, unknown> }>(
      {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: request.direction === 'BUY' ? MULTUP : MULTDOWN,
        currency: authorized.currency,
        symbol: request.symbol,
        multiplier,
        ...(request.stopLoss !== undefined ? { stop_loss: request.stopLoss } : {}),
        ...(request.takeProfit !== undefined ? { take_profit: request.takeProfit } : {}),
      },
      `proposal(${request.symbol})`,
    );

    const proposal = asRecord(proposalResponse.proposal);
    const proposalId = typeof proposal?.id === 'string' ? proposal.id : null;
    const price = proposal && isFiniteNumber(proposal.ask_price) ? proposal.ask_price : null;
    if (!proposalId || price === null) {
      return {
        ok: false,
        errorCode: 'PROPOSAL_UNAVAILABLE',
        brokerMessage: 'Deriv did not return a priced proposal for this contract.',
      };
    }

    // Re-checked at the moment of purchase: the cap may have been lowered while
    // the proposal was in flight.
    assertStakeWithinPlatformCap(stake);
    assertPayoutAboveFloor(
      price,
      proposal && isFiniteNumber(proposal.payout) ? proposal.payout : null,
    );

    const buyResponse = await client.request<{ buy?: Record<string, unknown> }>(
      { buy: proposalId, price },
      `buy(${request.symbol})`,
    );
    const buy = asRecord(buyResponse.buy);
    const contractId = buy && isFiniteNumber(buy.contract_id) ? String(buy.contract_id) : null;
    if (!contractId) {
      return {
        ok: false,
        errorCode: 'ORDER_REJECTED',
        brokerMessage: 'Deriv did not return a contract id for the order.',
      };
    }

    return {
      ok: true,
      orderId: contractId,
      positionId: contractId,
      fillPrice: buy && isFiniteNumber(buy.buy_price) ? buy.buy_price : price,
      // The stake is the money at risk (and the maximum loss) on a multiplier
      // contract: that is what `volume` carries for this broker.
      volume: stake,
      // And this is the exposure the contract actually opened: stake × multiplier.
      // Both are reported, so the ledger never has to derive one from the other.
      notional: Number((stake * multiplier).toFixed(2)),
      brokerMessage: `Deriv contract ${contractId}`,
    };
  }

  /**
   * Close a contract early (`sell` at market).
   *
   * Deriv contracts are not partially closable, so a volume argument is ignored;
   * the response is settled with a follow-up read because the sell call reports
   * the amount returned, not the exit spot or the profit.
   */
  async closePosition(positionId: string, _volume?: number): Promise<ClosePositionResult> {
    await this.requireTradingAuth();
    const client = await this.clientOrConnect();

    const contractId = Number(positionId);
    if (!Number.isInteger(contractId)) {
      return { ok: false, positionId, errorCode: 'INVALID_CONTRACT_ID', brokerMessage: 'Not a Deriv contract id.' };
    }

    const response = await client.request<{ sell?: Record<string, unknown> }>(
      { sell: contractId, price: 0 },
      `sell(${positionId})`,
    );
    const sell = asRecord(response.sell);
    if (!sell) {
      return {
        ok: false,
        positionId,
        errorCode: 'SELL_FAILED',
        brokerMessage: 'Deriv did not confirm the early close.',
      };
    }

    // The settled figures come from the contract itself.
    const closure = await this.getPositionClosure(positionId);

    return {
      ok: true,
      positionId,
      ...(closure?.exitPrice !== null && closure?.exitPrice !== undefined
        ? { closePrice: closure.exitPrice }
        : {}),
      ...(closure ? { netPnL: closure.netPnL } : {}),
      brokerMessage: `Deriv contract ${positionId} sold`,
    };
  }
}

export { DERIV_DEFAULT_URL };
