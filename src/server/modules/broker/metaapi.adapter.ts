/**
 * MetaApi broker adapter — `metaapi.cloud-sdk` v29 implementation of `BrokerAdapter`.
 *
 * ============================ ZERO-FABRICATION CONTRACT ============================
 * Every numeric field returned by this adapter (`balance`, `equity`, `freeMargin`,
 * `margin`, `leverage`, prices, volumes, P/L, commissions, swaps, specs) is copied
 * verbatim from a MetaApi SDK response. This file contains NO placeholder, NO
 * default, NO fallback and NO "0 if missing" value that could fabricate a price,
 * a P/L figure or a balance.
 *
 * Where the bridge does not report a value we return `null` / an empty array /
 * a `{ ok: false }` result and let the caller decide (the bot pipeline is
 * fail-closed — see `bot/risk.engine.ts`). If a broker response is malformed we
 * raise `ApiError.brokerUnavailable` instead of guessing.
 *
 * Package note: the npm package `@metaapi/metaapi-node-sdk` does not exist; the
 * real package is `metaapi.cloud-sdk`. All SDK classes/methods used below were
 * read from its shipped declarations (`node_modules/metaapi.cloud-sdk/dist/**`):
 *   - `MetaApi` (default export) — `new MetaApi(token, { region })`, `.close()`,
 *     `.metatraderAccountApi.getAccount(accountId)`
 *   - `MetatraderAccount` — `.state`, `.connectionStatus`, `.reload()`,
 *     `.getRPCConnection()`, `.getStreamingConnection()`, `.waitConnected()`,
 *     `.getHistoricalCandles(symbol, timeframe, startTime?, limit?)`
 *   - `RpcMetaApiConnectionInstance` — `.connect()`, `.getAccountInformation()`,
 *     `.getPositions()`, `.getPosition(id)`, `.getDealsByTimeRange(a,b,off,limit)`,
 *     `.getDealsByPosition(id)`, `.getSymbolSpecification(symbol)`,
 *     `.getSymbolPrice(symbol, keepSubscription)`, `.getServerTime()`,
 *     `.calculateMargin(order)`, `.createMarketBuyOrder/.createMarketSellOrder`,
 *     `.closePosition/.closePositionPartially`, `.close()`
 *   - `StreamingMetaApiConnectionInstance` — `.connect()`, `.addSynchronizationListener()`,
 *     `.waitSynchronized({ timeoutInSeconds })`, `.close()`
 *   - `SynchronizationListener` — extended by `MetaApiSyncListener` below; the SDK
 *     dispatches `onPositionUpdated`, `onPositionsReplaced`, `onPositionRemoved`,
 *     `onDealAdded`, `onSymbolPriceUpdated`, `onConnected`, `onDisconnected`,
 *     `onBrokerConnectionStatusChanged` on it.
 *
 * The SDK itself rejects a trade unless the response `stringCode` is one of
 * ERR_NO_ERROR / TRADE_RETCODE_PLACED / TRADE_RETCODE_DONE / TRADE_RETCODE_DONE_PARTIAL /
 * TRADE_RETCODE_NO_CHANGES (metaApiWebsocket.client.js `_trade`); we re-check the
 * same list so `ok: true` is only ever returned for a broker-confirmed fill.
 *
 * The access token is never logged, never returned and never put in an error.
 * ==================================================================================
 */

import { performance } from 'node:perf_hooks';
import MetaApi from 'metaapi.cloud-sdk';
import {
  SynchronizationListener,
  type MarginOrder,
  type MetatraderAccount,
  type MetatraderAccountInformation,
  type MetatraderCandle,
  type MetatraderDeal,
  type MetatraderDeals,
  type MetatraderPosition,
  type MetatraderSymbolPrice,
  type MetatraderSymbolSpecification,
  type MetatraderTradeResponse,
  type RpcMetaApiConnectionInstance,
  type StreamingMetaApiConnectionInstance,
} from 'metaapi.cloud-sdk';
import { ApiError } from '@/lib/http';
import { D, Decimal } from '@/lib/money';
import { maskAccount } from '@/lib/crypto/credential-cipher';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerDeal,
  BrokerEnvironment,
  BrokerEventHandlers,
  BrokerPosition,
  BrokerStatus,
  Candle,
  ClosePositionResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  Quote,
  SymbolSpec,
} from './broker.types';

/** Constructor config for one MetaApi account (one trading account = one adapter). */
export interface MetaApiBrokerAdapterConfig {
  accountId: string;
  brokerName: string;
  environment: BrokerEnvironment;
  token: string;
  region: string;
  /** Seconds to wait for terminal synchronization on connect. */
  terminalTimeout: number;
}

/**
 * Account states that mean "the bridge cannot trade this account right now".
 * Mirrors `MetatraderAccountClient.State` in the SDK; anything here is `ERROR`.
 */
export const TERMINAL_ERROR_STATES: readonly string[] = [
  'DEPLOY_FAILED',
  'UNDEPLOY_FAILED',
  'DELETE_FAILED',
  'REDEPLOY_FAILED',
];

export function isTerminalErrorState(state: string | null | undefined): boolean {
  return typeof state === 'string' && TERMINAL_ERROR_STATES.includes(state);
}

/**
 * The exact `stringCode` values the SDK accepts as a successful trade
 * (`metaApiWebsocket.client.js`, `_trade`). Anything else is an error.
 */
const TRADE_SUCCESS_CODES: readonly string[] = [
  'ERR_NO_ERROR',
  'TRADE_RETCODE_PLACED',
  'TRADE_RETCODE_DONE',
  'TRADE_RETCODE_DONE_PARTIAL',
  'TRADE_RETCODE_NO_CHANGES',
];

/** Broker-side comment/clientId budget documented by MetaApi (26 together, 31 alone). */
export const BROKER_COMMENT_BUDGET = 26;

/** Deal types that carry a trading direction; everything else is not mappable. */
const TRADE_DEAL_TYPES: readonly string[] = ['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL'];

/** Mapped investment tag written into a position comment: `inv:<uuid>`. */
const INVESTMENT_TAG_RE = /inv:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Extract `inv:<uuid>` from a comment/clientId. Returns null when absent. */
export function extractInvestmentIdTag(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = INVESTMENT_TAG_RE.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Complete, broker-reported result of closing one position. Every field is read
 * from the closing deals; nothing is derived from our own bookkeeping.
 */
export interface PositionClosure {
  positionId: string;
  /** Volume-weighted average price of the closing deals, or null when unreported. */
  exitPrice: number | null;
  /** Total volume reported by the closing deals (lots), or null when unreported. */
  closingVolume: number | null;
  grossPnL: number;
  commission: number;
  swap: number;
  netPnL: number;
  /** Execution time of the last closing deal, or null when the bridge sent none. */
  closedAt: Date | null;
  dealIds: string[];
}

/**
 * Extra adapter capabilities that callers probe for (they are intentionally not
 * added to the shared `BrokerAdapter` contract). A caller that cannot find one of
 * these must fail closed — never fall back to an assumed value.
 */
export interface MarginCapableAdapter {
  /** Broker-computed margin for a prospective order; null when the broker was silent. */
  calculateRequiredMargin(
    symbol: string,
    direction: 'BUY' | 'SELL',
    volume: number,
    openPrice: number,
  ): Promise<number | null>;
}

export interface TradabilityCapableAdapter {
  /** True/False per the broker's symbol trade mode; null when it is not reported. */
  isSymbolTradable(symbol: string): Promise<boolean | null>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A number the caller requires. Never substitutes a default: a malformed bridge
 * response must surface as an outage, not as a made-up balance.
 */
function requireNumber(value: unknown, field: string): number {
  if (!isFiniteNumber(value)) {
    throw ApiError.brokerUnavailable(
      `MetaApi response is missing a usable "${field}" value. Refusing to substitute a default.`,
    );
  }
  return value;
}

/** ISO string | Date | epoch → Date, or null when the bridge sent something unusable. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toUnixSeconds(value: unknown): number | null {
  const date = toDate(value);
  return date ? Math.floor(date.getTime() / 1000) : null;
}

function readUnknown(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

function readString(source: unknown, key: string): string | null {
  const value = readUnknown(source, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Broker error → `{ errorCode, brokerMessage }`. Never leaks the token. */
function mapBrokerError(err: unknown): { errorCode: string; brokerMessage: string } {
  if (err instanceof Error) {
    const code = readString(err, 'stringCode');
    const numeric = readUnknown(err, 'numericCode');
    const brokerMessage =
      typeof err.message === 'string' && err.message.length > 0 ? err.message : 'Broker rejected the request.';
    return {
      errorCode: code ?? `METAAPI_${err.name || 'ERROR'}${isFiniteNumber(numeric) ? `_${numeric}` : ''}`,
      brokerMessage,
    };
  }
  return { errorCode: 'METAAPI_ERROR', brokerMessage: 'Broker call failed with a non-Error value.' };
}

/**
 * Streaming/RPC synchronization listener.
 *
 * The SDK's v29 listener has no `onPositionOpened`; an opened position arrives as
 * `onPositionUpdated` for an id we have not seen before, so the first sighting of
 * a position id is reported as *opened* and every later sighting as *updated*.
 * Bulk snapshots (`onPositionsReplaced`) only seed that bookkeeping — they are not
 * re-published as per-position events.
 */
class MetaApiSyncListener extends SynchronizationListener {
  private readonly knownPositions = new Map<string, BrokerPosition>();
  private readonly closedPositions = new Set<string>();

  constructor(
    private readonly opts: {
      mapPosition: (raw: MetatraderPosition) => BrokerPosition | null;
      mapDeal: (raw: MetatraderDeal) => BrokerDeal | null;
      handlers: BrokerEventHandlers;
      /** Adapter-internal: keeps `isConnected()` aligned with the socket. */
      onConnectionStateChange?: (connected: boolean) => void;
    },
  ) {
    super();
  }

  /** Every handler invocation is isolated: a listener must never break the stream. */
  private async safe(label: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error(`[metaapi.adapter] handler ${label} failed:`, err instanceof Error ? err.message : err);
    }
  }

  override async onPositionsReplaced(_instanceIndex: string, positions: Array<MetatraderPosition>): Promise<void> {
    for (const raw of positions) {
      const mapped = this.opts.mapPosition(raw);
      if (mapped) this.knownPositions.set(mapped.positionId, mapped);
    }
  }

  override async onPositionUpdated(instanceIndex: string, position: MetatraderPosition): Promise<void> {
    const mapped = this.opts.mapPosition(position);
    if (!mapped) return; // Unmappable broker payload — skipped, never substituted.
    const seen = this.knownPositions.has(mapped.positionId);
    this.knownPositions.set(mapped.positionId, mapped);
    if (!seen) {
      await this.safe('onPositionOpened', () => this.opts.handlers.onPositionOpened?.(mapped) ?? undefined);
    }
    await this.safe('onPositionUpdated', () => this.opts.handlers.onPositionUpdated?.(mapped) ?? undefined);
  }

  override async onPositionRemoved(_instanceIndex: string, positionId: string): Promise<void> {
    const known = this.knownPositions.get(positionId);
    this.knownPositions.delete(positionId);
    // `onDealAdded` normally reports the close together with its deal; when it has
    // already done so we must not publish the same close twice.
    if (this.closedPositions.has(positionId)) return;
    this.closedPositions.add(positionId);
    await this.safe('onPositionClosed', () =>
      this.opts.handlers.onPositionClosed?.({
        positionId,
        investmentId: extractInvestmentIdTag(known?.comment ?? null),
        deal: null,
      }) ?? undefined,
    );
  }

  override async onDealAdded(instanceIndex: string, deal: MetatraderDeal): Promise<void> {
    if (typeof deal.entryType !== 'string' || !deal.entryType.startsWith('DEAL_ENTRY_OUT')) return;
    const mapped = this.opts.mapDeal(deal);
    if (!mapped) return;
    const known = this.knownPositions.get(mapped.positionId);
    this.knownPositions.delete(mapped.positionId);
    this.closedPositions.add(mapped.positionId);
    await this.safe('onPositionClosed', () =>
      this.opts.handlers.onPositionClosed?.({
        positionId: mapped.positionId,
        investmentId: extractInvestmentIdTag(known?.comment ?? null) ?? extractInvestmentIdTag(mapped.comment),
        deal: mapped,
      }) ?? undefined,
    );
  }

  override async onSymbolPriceUpdated(_instanceIndex: string, price: MetatraderSymbolPrice): Promise<void> {
    if (!isFiniteNumber(price.bid) || !isFiniteNumber(price.ask)) return;
    const time = toUnixSeconds(price.time);
    if (time === null) return;
    const quote: Quote = { symbol: price.symbol, bid: price.bid, ask: price.ask, time };
    await this.safe('onQuote', () => this.opts.handlers.onQuote?.(quote) ?? undefined);
  }

  override async onConnected(_instanceIndex: string, _replicas: number): Promise<void> {
    this.opts.onConnectionStateChange?.(true);
    await this.safe('onConnectionState', () =>
      this.opts.handlers.onConnectionState?.({ connected: true, state: 'CONNECTED' }) ?? undefined,
    );
  }

  override async onDisconnected(_instanceIndex: string): Promise<void> {
    this.opts.onConnectionStateChange?.(false);
    await this.safe('onConnectionState', () =>
      this.opts.handlers.onConnectionState?.({ connected: false, state: 'DISCONNECTED' }) ?? undefined,
    );
  }

  override async onBrokerConnectionStatusChanged(_instanceIndex: string, connected: boolean): Promise<void> {
    await this.safe('onConnectionState', () =>
      this.opts.handlers.onConnectionState?.({
        connected,
        state: connected ? 'BROKER_CONNECTED' : 'BROKER_DISCONNECTED',
      }) ?? undefined,
    );
  }
}

export class MetaApiBrokerAdapter implements BrokerAdapter {
  /** Symbol-spec cache TTL. Specs change rarely; quotes and P/L are never cached. */
  private static readonly SPEC_CACHE_TTL_MS = 60_000;

  public readonly accountId: string;
  private readonly config: MetaApiBrokerAdapterConfig;
  private readonly specCache = new Map<string, { spec: SymbolSpec; expiresAt: number }>();

  private client: MetaApi | null = null;
  private account: MetatraderAccount | null = null;
  private rpc: RpcMetaApiConnectionInstance | null = null;
  private streaming: StreamingMetaApiConnectionInstance | null = null;
  private listener: MetaApiSyncListener | null = null;
  private handlers: BrokerEventHandlers = {};
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(config: MetaApiBrokerAdapterConfig) {
    this.accountId = config.accountId;
    this.config = config;
  }

  // ---------------------------------------------------------------- connection

  /**
   * Idempotent. The MetaApi client, account entity, RPC and streaming connections
   * are created here — never at module import time, so importing this file during
   * `next build` cannot fail for missing credentials.
   */
  async connect(handlers: BrokerEventHandlers): Promise<void> {
    this.handlers = handlers;
    if (this.connected && this.rpc && this.streaming) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<void> {
    if (!this.config.token || this.config.token.trim().length === 0) {
      throw ApiError.brokerUnavailable('No MetaApi token available for this broker connection.');
    }

    // A previous half-open session is torn down before rebuilding.
    if (this.rpc || this.streaming) await this.disconnect();

    const client = this.client ?? new MetaApi(this.config.token, { region: this.config.region });
    this.client = client;

    const account = this.account ?? (await client.metatraderAccountApi.getAccount(this.config.accountId));
    this.account = account;

    await account.waitConnected(this.config.terminalTimeout);

    const listener = new MetaApiSyncListener({
      mapPosition: (raw) => this.mapPosition(raw),
      mapDeal: (raw) => this.mapDeal(raw),
      handlers: this.handlers,
      onConnectionStateChange: (isConnected) => {
        this.connected = isConnected;
      },
    });
    this.listener = listener;

    const streaming = account.getStreamingConnection();
    streaming.addSynchronizationListener(listener);
    await streaming.connect();
    await streaming.waitSynchronized({ timeoutInSeconds: this.config.terminalTimeout });

    const rpc = account.getRPCConnection();
    await rpc.connect();
    await rpc.waitSynchronized(this.config.terminalTimeout);

    this.streaming = streaming;
    this.rpc = rpc;
    this.connected = true;
    console.info(`[metaapi.adapter] connected account=${this.config.accountId} region=${this.config.region}`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const streaming = this.streaming;
    const rpc = this.rpc;
    const listener = this.listener;
    this.streaming = null;
    this.rpc = null;
    this.listener = null;

    try {
      if (streaming && listener) streaming.removeSynchronizationListener(listener);
    } catch (err) {
      console.error('[metaapi.adapter] listener removal failed:', err instanceof Error ? err.message : err);
    }
    try {
      if (streaming) await streaming.close();
    } catch (err) {
      console.error('[metaapi.adapter] streaming close failed:', err instanceof Error ? err.message : err);
    }
    try {
      if (rpc) await rpc.close();
    } catch (err) {
      console.error('[metaapi.adapter] rpc close failed:', err instanceof Error ? err.message : err);
    }
    try {
      this.client?.close();
    } catch (err) {
      console.error('[metaapi.adapter] client close failed:', err instanceof Error ? err.message : err);
    }
    this.client = null;
    this.account = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private requireRpc(): RpcMetaApiConnectionInstance {
    if (!this.rpc || !this.connected) {
      throw ApiError.brokerUnavailable('MetaApi connection is not established for this account.');
    }
    return this.rpc;
  }

  // ------------------------------------------------------------- account state

  private async loadAccount(): Promise<MetatraderAccount> {
    if (!this.account) {
      const client = this.client;
      if (!client) throw ApiError.brokerUnavailable('MetaApi client is not initialised.');
      this.account = await client.metatraderAccountApi.getAccount(this.config.accountId);
    }
    return this.account;
  }

  /** Account state + raw terminal state, straight from the bridge. */
  async getAccountState(): Promise<BrokerAccountState> {
    const rpc = this.requireRpc();
    const account = await this.loadAccount();

    // Re-read the account entity only when it looks disconnected, so the reported
    // status cannot be a stale "DISCONNECTED" from before a recovery.
    if (account.connectionStatus !== 'CONNECTED') {
      try {
        await account.reload();
      } catch (err) {
        console.error('[metaapi.adapter] account reload failed:', err instanceof Error ? err.message : err);
      }
    }

    const rawState: string = typeof account.state === 'string' ? account.state : '';
    const info: MetatraderAccountInformation = await rpc.getAccountInformation();

    const balance = requireNumber(info.balance, 'balance');
    const equity = requireNumber(info.equity, 'equity');
    const freeMargin = requireNumber(info.freeMargin, 'freeMargin');
    const margin = requireNumber(info.margin, 'margin');
    const leverage = requireNumber(info.leverage, 'leverage');

    const login = isFiniteNumber(info.login) ? String(info.login) : null;
    const status: BrokerStatus = isTerminalErrorState(rawState)
      ? 'ERROR'
      : account.connectionStatus === 'CONNECTED'
        ? 'CONNECTED'
        : 'DISCONNECTED';

    return {
      accountId: this.config.accountId,
      brokerName: this.config.brokerName,
      environment: this.config.environment,
      // Display mask only, derived from the login the broker reported. When the
      // bridge sends no login we say so instead of printing a plausible-looking one.
      maskedAccount: login ? maskAccount(login) : '***-unknown',
      currency: typeof info.currency === 'string' ? info.currency : '',
      balance,
      equity,
      freeMargin,
      margin,
      leverage,
      // Investor (read-only) passwords and disabled trading are not actionable.
      isTradingEnabled: info.tradeAllowed === true && info.investorMode !== true && !isTerminalErrorState(rawState),
      status,
      rawState,
      updatedAt: new Date(),
    };
  }

  /** Real RPC round-trip: `getServerTime`. Null when the call fails. */
  async ping(): Promise<number | null> {
    const rpc = this.rpc;
    if (!rpc || !this.connected) return null;
    const startedAt = performance.now();
    try {
      await rpc.getServerTime();
      return Math.round((performance.now() - startedAt) * 100) / 100;
    } catch (err) {
      console.error('[metaapi.adapter] ping failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ----------------------------------------------------------------- positions

  private mapPosition(raw: MetatraderPosition): BrokerPosition | null {
    const positionId = isFiniteNumber(raw.id) ? String(raw.id) : null;
    const direction =
      raw.type === 'POSITION_TYPE_BUY' ? 'BUY' : raw.type === 'POSITION_TYPE_SELL' ? 'SELL' : null;
    const openedAt = toDate(raw.time);

    // An unmappable position is dropped and logged — it is never completed with an
    // invented direction, price or timestamp.
    if (!positionId || !direction || !openedAt) {
      console.warn(
        `[metaapi.adapter] skipping position with unusable payload (id=${String(raw.id)} type=${String(raw.type)})`,
      );
      return null;
    }
    if (
      !isFiniteNumber(raw.volume) ||
      !isFiniteNumber(raw.openPrice) ||
      !isFiniteNumber(raw.currentPrice) ||
      !isFiniteNumber(raw.unrealizedProfit) ||
      !isFiniteNumber(raw.commission) ||
      !isFiniteNumber(raw.swap)
    ) {
      console.warn(`[metaapi.adapter] skipping position ${positionId} with non-numeric broker fields`);
      return null;
    }

    const comment = readString(raw, 'comment') ?? readString(raw, 'brokerComment');
    const clientId = readString(raw, 'clientId');

    return {
      positionId,
      instrument: raw.symbol,
      direction,
      volume: raw.volume,
      entryPrice: raw.openPrice,
      currentPrice: raw.currentPrice,
      stopLoss: isFiniteNumber(raw.stopLoss) ? raw.stopLoss : null,
      takeProfit: isFiniteNumber(raw.takeProfit) ? raw.takeProfit : null,
      // `raw.profit` is CUMULATIVE (open part + already-closed part, incl. swap and
      // commission); `raw.unrealizedProfit` is the open part only, excluding swap and
      // commission. An *unrealized* P/L field must be the latter.
      unrealizedPnL: raw.unrealizedProfit,
      commission: raw.commission,
      swap: raw.swap,
      comment,
      openedAt,
      investmentId: extractInvestmentIdTag(comment) ?? extractInvestmentIdTag(clientId),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const rpc = this.requireRpc();
    const raw = await rpc.getPositions();
    const positions: BrokerPosition[] = [];
    for (const item of raw) {
      const mapped = this.mapPosition(item);
      if (mapped) positions.push(mapped);
    }
    return positions;
  }

  // --------------------------------------------------------------------- deals

  /**
   * MetaApi declares `commission`/`swap` as optional because non-trade deals
   * (balance, credit, commission-only) do not carry them. On a BUY/SELL deal an
   * absent field means the broker reported no such charge for THAT deal (MT5
   * semantics: nothing was charged), which is not a substituted price/P/L/balance.
   * It is logged, so a broker that silently stops reporting it is visible instead
   * of quietly changing every net P/L figure.
   */
  private readCharge(value: unknown, field: 'commission' | 'swap', dealId: string): number {
    if (isFiniteNumber(value)) return value;
    console.warn(
      `[metaapi.adapter] deal ${dealId} reported no ${field}; reading it as 0 for that deal (MT5 semantics).`,
    );
    return 0;
  }

  private mapDeal(raw: MetatraderDeal): BrokerDeal | null {
    if (typeof raw.type !== 'string' || !TRADE_DEAL_TYPES.includes(raw.type)) return null;
    const direction = raw.type === 'DEAL_TYPE_SELL' ? 'SELL' : 'BUY';
    const positionId = readString(raw, 'positionId');
    const symbol = readString(raw, 'symbol');
    const executedAt = toDate(raw.time);

    if (!positionId || !symbol || !executedAt) return null;
    if (!isFiniteNumber(raw.price) || !isFiniteNumber(raw.volume) || !isFiniteNumber(raw.profit)) return null;

    const dealId = String(raw.id);
    const commission = this.readCharge(raw.commission, 'commission', dealId);
    const swap = this.readCharge(raw.swap, 'swap', dealId);

    return {
      dealId,
      positionId,
      instrument: symbol,
      direction,
      volume: raw.volume,
      price: raw.price,
      grossPnL: raw.profit,
      commission,
      swap,
      netPnL: D(raw.profit).plus(commission).plus(swap).toNumber(),
      executedAt,
      comment: readString(raw, 'comment') ?? readString(raw, 'brokerComment'),
    };
  }

  /**
   * History deals in `[since, now]`, paged in 1000-row blocks. Only trade deals
   * (DEAL_TYPE_BUY / DEAL_TYPE_SELL) are mapped: `BrokerDeal.direction` has no
   * truthful value for balance/credit/commission-only deal records, and inventing
   * one would misattribute money.
   */
  async getDealsSince(since: Date): Promise<BrokerDeal[]> {
    const rpc = this.requireRpc();
    const until = new Date();
    const limit = 1000;
    const maxPages = 10;
    const deals: BrokerDeal[] = [];
    let offset = 0;
    let skipped = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const response: MetatraderDeals = await rpc.getDealsByTimeRange(since, until, offset, limit);
      const batch = Array.isArray(response.deals) ? response.deals : [];
      for (const raw of batch) {
        const mapped = this.mapDeal(raw);
        if (mapped) deals.push(mapped);
        else skipped += 1;
      }
      if (batch.length < limit) break;
      offset += batch.length;
    }

    if (skipped > 0) {
      console.warn(
        `[metaapi.adapter] ${skipped} deal(s) between ${since.toISOString()} and ${until.toISOString()} were not mappable (non-trade or incomplete) and are excluded.`,
      );
    }
    return deals;
  }

  /**
   * Complete closing-deal aggregate for one position: every `DEAL_ENTRY_OUT*` deal of
   * that position (not just those inside a sync window), so a position that was closed
   * in several parts is always accounted for in full. Returns null when the broker
   * reports no closing deal — callers must then leave the ledger row untouched.
   */
  async getPositionClosure(positionId: string): Promise<PositionClosure | null> {
    const rpc = this.requireRpc();
    const response: MetatraderDeals = await rpc.getDealsByPosition(positionId);
    const deals = Array.isArray(response.deals) ? response.deals : [];
    const outs = deals.filter(
      (deal) => typeof deal.entryType === 'string' && deal.entryType.startsWith('DEAL_ENTRY_OUT'),
    );
    if (outs.length === 0) return null;

    let gross = D(0);
    let commission = D(0);
    let swap = D(0);
    let weighted = D(0);
    let volume = D(0);
    let closedAt: Date | null = null;
    const dealIds: string[] = [];

    for (const deal of outs) {
      const dealId = String(deal.id);
      if (!isFiniteNumber(deal.profit)) {
        // A closing deal with no P/L is unusable: return nothing so the ledger row
        // stays OPEN and the next cycle retries, instead of booking a zero result.
        console.warn(`[metaapi.adapter] closing deal ${dealId} reported no profit; closure withheld.`);
        return null;
      }
      gross = gross.plus(deal.profit);
      commission = commission.plus(this.readCharge(deal.commission, 'commission', dealId));
      swap = swap.plus(this.readCharge(deal.swap, 'swap', dealId));
      if (isFiniteNumber(deal.price) && isFiniteNumber(deal.volume) && deal.volume > 0) {
        weighted = weighted.plus(D(deal.price).times(deal.volume));
        volume = volume.plus(deal.volume);
      }
      const time = toDate(deal.time);
      if (time && (closedAt === null || time.getTime() > closedAt.getTime())) closedAt = time;
      dealIds.push(dealId);
    }

    return {
      positionId,
      exitPrice: volume.greaterThan(0) ? weighted.div(volume).toDecimalPlaces(5, Decimal.ROUND_HALF_UP).toNumber() : null,
      closingVolume: volume.greaterThan(0) ? volume.toNumber() : null,
      grossPnL: gross.toNumber(),
      commission: commission.toNumber(),
      swap: swap.toNumber(),
      netPnL: gross.plus(commission).plus(swap).toNumber(),
      closedAt,
      dealIds,
    };
  }

  // ---------------------------------------------------------------- market data

  /** Historical candles in ascending time order, straight from the account. */
  async getHistoricalCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const account = await this.loadAccount();
    const limit = Math.max(1, Math.min(Math.trunc(count), 1000));
    const raw: Array<MetatraderCandle> = await account.getHistoricalCandles(symbol, timeframe, undefined, limit);

    const candles: Candle[] = [];
    let skipped = 0;
    for (const candle of raw) {
      const time = toUnixSeconds(candle.time);
      if (
        time === null ||
        !isFiniteNumber(candle.open) ||
        !isFiniteNumber(candle.high) ||
        !isFiniteNumber(candle.low) ||
        !isFiniteNumber(candle.close)
      ) {
        skipped += 1;
        continue;
      }
      candles.push({
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        ...(isFiniteNumber(candle.tickVolume) ? { volume: candle.tickVolume } : {}),
      });
    }
    if (skipped > 0) {
      console.warn(`[metaapi.adapter] ${skipped} candle(s) for ${symbol} ${timeframe} had unusable fields and were dropped.`);
    }
    // The endpoint loads candles backwards; consumers expect oldest → newest.
    return candles.sort((a, b) => a.time - b.time);
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    const rpc = this.requireRpc();
    try {
      const price: MetatraderSymbolPrice = await rpc.getSymbolPrice(symbol, false);
      const time = toUnixSeconds(price.time);
      if (!isFiniteNumber(price.bid) || !isFiniteNumber(price.ask) || time === null) return null;
      return { symbol: price.symbol, bid: price.bid, ask: price.ask, time };
    } catch (err) {
      console.error('[metaapi.adapter] getQuote failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Symbol specification. CACHED for `SPEC_CACHE_TTL_MS` (specs only) — nothing else
   * in this adapter is cached, and no cache is ever used to supply a price or P/L.
   */
  async getSymbolSpec(symbol: string): Promise<SymbolSpec | null> {
    const cached = this.specCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.spec;

    const rpc = this.requireRpc();
    try {
      const raw: MetatraderSymbolSpecification = await rpc.getSymbolSpecification(symbol);
      if (
        !isFiniteNumber(raw.digits) ||
        !isFiniteNumber(raw.volumeStep) ||
        !isFiniteNumber(raw.minVolume) ||
        !isFiniteNumber(raw.maxVolume) ||
        !isFiniteNumber(raw.contractSize) ||
        !isFiniteNumber(raw.tickSize)
      ) {
        return null;
      }
      const spec: SymbolSpec = {
        symbol: raw.symbol,
        digits: raw.digits,
        volumeStep: raw.volumeStep,
        minVolume: raw.minVolume,
        maxVolume: raw.maxVolume,
        contractSize: raw.contractSize,
        // The specification carries no tick value; this is arithmetic on two
        // broker-reported fields (value of one tick for 1 lot in the symbol's PROFIT
        // currency) — never a constant. Use `calculateRequiredMargin()` for a true
        // account-currency margin figure.
        tickValue: D(raw.tickSize).times(raw.contractSize).toNumber(),
      };
      this.specCache.set(symbol, { spec, expiresAt: Date.now() + MetaApiBrokerAdapter.SPEC_CACHE_TTL_MS });
      return spec;
    } catch (err) {
      console.error('[metaapi.adapter] getSymbolSpec failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ------------------------------------------------- extra capabilities (beyond BrokerAdapter)

  /**
   * Broker-computed margin for an order (`calculateMargin` RPC). Returns null when
   * the broker did not report a margin figure — the risk gate treats null as a
   * rejection rather than assuming the order fits.
   *
   * Declared as `MarginCapableAdapter` so callers probe for the capability instead
   * of extending the shared `BrokerAdapter` contract.
   */
  async calculateRequiredMargin(
    symbol: string,
    direction: 'BUY' | 'SELL',
    volume: number,
    openPrice: number,
  ): Promise<number | null> {
    const rpc = this.requireRpc();
    try {
      const order: MarginOrder = {
        symbol,
        type: direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
        volume,
        openPrice,
      };
      const margin = await rpc.calculateMargin(order);
      const value = readUnknown(margin, 'margin');
      return isFiniteNumber(value) ? value : null;
    } catch (err) {
      console.error('[metaapi.adapter] calculateMargin failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Whether the broker's own symbol specification allows trading. Returns null when
   * the trade mode is not reported, which callers must treat as "not tradable".
   */
  async isSymbolTradable(symbol: string): Promise<boolean | null> {
    const rpc = this.requireRpc();
    try {
      const raw: MetatraderSymbolSpecification = await rpc.getSymbolSpecification(symbol);
      const tradeMode = readString(raw, 'tradeMode');
      if (!tradeMode) return null;
      return tradeMode === 'SYMBOL_TRADE_MODE_FULL' || tradeMode === 'SYMBOL_TRADE_MODE_LONGONLY' || tradeMode === 'SYMBOL_TRADE_MODE_SHORTONLY';
    } catch (err) {
      console.error('[metaapi.adapter] isSymbolTradable failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ------------------------------------------------------------------- trading

  /**
   * Market order (the SDK's `createMarketBuyOrder` / `createMarketSellOrder`).
   * `PlaceOrderRequest` carries no pending entry price, so the stop/limit variants
   * (`createStopBuyOrder`, `createLimitBuyOrder`, …) are not reachable from this
   * contract. SDK/broker rejections are mapped into `{ ok: false }` — this method
   * never throws for a broker rejection and never reports `ok: true` without a
   * confirmed trade response.
   *
   * KNOWN BROKER CONSTRAINT: MetaApi documents that comment + clientId must fit in
   * ~26–31 characters at the broker. The client order id is used verbatim as the
   * comment (as required for traceability); brokers may therefore truncate it. The
   * sync layer is fail-closed about this — a position whose `inv:` tag did not
   * survive is reported as `unattributed` instead of being attributed by guesswork.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    let rpc: RpcMetaApiConnectionInstance;
    try {
      rpc = this.requireRpc();
    } catch (err) {
      const mapped = mapBrokerError(err);
      return { ok: false, errorCode: mapped.errorCode, brokerMessage: mapped.brokerMessage };
    }

    const options = {
      comment: request.clientOrderId,
      // clientId is only set when it fits the documented budget, so a long
      // idempotency key cannot make the broker reject the order outright.
      ...(request.clientOrderId.length <= BROKER_COMMENT_BUDGET ? { clientId: request.clientOrderId } : {}),
    };

    let response: MetatraderTradeResponse;
    try {
      response =
        request.direction === 'BUY'
          ? await rpc.createMarketBuyOrder(request.symbol, request.volume, request.stopLoss, request.takeProfit, options)
          : await rpc.createMarketSellOrder(request.symbol, request.volume, request.stopLoss, request.takeProfit, options);
    } catch (err) {
      const mapped = mapBrokerError(err);
      return { ok: false, errorCode: mapped.errorCode, brokerMessage: mapped.brokerMessage };
    }

    // Defence in depth: the SDK already enforces this list, we re-verify instead of
    // trusting that a resolved promise means a fill.
    if (typeof response.stringCode !== 'string' || !TRADE_SUCCESS_CODES.includes(response.stringCode)) {
      return {
        ok: false,
        errorCode: response.stringCode || 'TRADE_RETCODE_UNKNOWN',
        brokerMessage: response.message || 'Broker returned a non-success trade response.',
      };
    }

    const positionId = readString(response, 'positionId');
    const result: PlaceOrderResult = {
      ok: true,
      ...(readString(response, 'orderId') ? { orderId: response.orderId } : {}),
      ...(positionId ? { positionId } : {}),
      brokerMessage: response.message || response.stringCode,
    };

    // Fill price/volume are read back from the broker's position record. If the
    // terminal has not materialised the position yet, both stay undefined — the
    // caller persists nothing rather than storing a guessed entry price.
    if (positionId) {
      try {
        const position: MetatraderPosition = await rpc.getPosition(positionId);
        if (isFiniteNumber(position.openPrice)) result.fillPrice = position.openPrice;
        if (isFiniteNumber(position.volume)) result.volume = position.volume;
      } catch (err) {
        console.warn(
          `[metaapi.adapter] position ${positionId} not readable right after the fill:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return result;
  }

  /** Partial close when a volume is given, full close otherwise. */
  async closePosition(positionId: string, volume?: number): Promise<ClosePositionResult> {
    let rpc: RpcMetaApiConnectionInstance;
    try {
      rpc = this.requireRpc();
    } catch (err) {
      const mapped = mapBrokerError(err);
      return { ok: false, positionId, errorCode: mapped.errorCode, brokerMessage: mapped.brokerMessage };
    }

    let response: MetatraderTradeResponse;
    try {
      response =
        isFiniteNumber(volume) && volume > 0
          ? await rpc.closePositionPartially(positionId, volume, {})
          : await rpc.closePosition(positionId, {});
    } catch (err) {
      const mapped = mapBrokerError(err);
      return { ok: false, positionId, errorCode: mapped.errorCode, brokerMessage: mapped.brokerMessage };
    }

    if (typeof response.stringCode !== 'string' || !TRADE_SUCCESS_CODES.includes(response.stringCode)) {
      return {
        ok: false,
        positionId,
        errorCode: response.stringCode || 'TRADE_RETCODE_UNKNOWN',
        brokerMessage: response.message || 'Broker returned a non-success close response.',
      };
    }

    const result: ClosePositionResult = {
      ok: true,
      positionId,
      brokerMessage: response.message || response.stringCode,
    };
    try {
      const closure = await this.getPositionClosure(positionId);
      if (closure) {
        if (closure.exitPrice !== null) result.closePrice = closure.exitPrice;
        result.netPnL = closure.netPnL;
      }
    } catch (err) {
      console.warn(
        `[metaapi.adapter] close deals for position ${positionId} are not readable yet:`,
        err instanceof Error ? err.message : err,
      );
    }
    return result;
  }
}
