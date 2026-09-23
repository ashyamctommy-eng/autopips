/**
 * Browser-side socket helper for the trading channel.
 *
 * Contains NO secrets and never touches `localStorage`: the access token lives
 * in an httpOnly, SameSite=Lax cookie (`ACCESS_COOKIE` on the server), so the
 * browser sends it automatically on the handshake and JavaScript can never
 * read or leak it.
 *
 * Auth precedence on the server (`socket-server.ts`):
 *   1. `handshake.auth.token`  — used by this client only for the fallback
 *      short-lived socket token (kept in module memory, never persisted).
 *   2. the httpOnly access cookie — the normal path, enabled by
 *      `withCredentials: true`.
 * A query-string token is rejected by design (it leaks into access logs).
 *
 * ── Why `TradingSocket` is declared locally ─────────────────────────────────
 * The types that ship with `socket.io-client@4` are shadowed in this repo:
 * `node_modules/@types/socket.io-client@1.4.33` (a transitive dependency of
 * metaapi.cloud-sdk) contains an ambient `declare module 'socket.io-client' {
 * export = io }` for Socket.IO **v1**, and ambient declarations win over a
 * package's own bundled types. Importing the bare package for *types*
 * therefore yields a v1 `Socket`, which has no generics and cannot describe the
 * typed event map below. The runtime import is unaffected.
 *
 * `TradingSocket` is the structural subset of the v4 `Socket` this app uses
 * (`on`/`off`/`emit`/`connect`/`disconnect`/`connected`/`active`/`id`), typed
 * against the real event names, so no `any` is needed anywhere.
 * Team fix (out of this module's scope): drop the stale `@types` shim, or pin
 * `compilerOptions.types` in tsconfig.json.
 */

import * as socketIoClientRuntime from 'socket.io-client';

import { WS_EVENTS } from '@/lib/contracts';
import type { AccountOverview, ActivityEventDTO, PositionDTO } from '@/types/api';

/** Namespace path — must match `TRADING_NAMESPACE` on the server. */
export const TRADING_SOCKET_NAMESPACE = '/ws/trading';
/** engine.io HTTP path — must match the server's `path` option. */
export const TRADING_SOCKET_PATH = '/ws/socket.io';

/** Fallback endpoint implemented by the auth module owner. */
export const SOCKET_TOKEN_ENDPOINT = '/api/v1/auth/socket-token';

/* ─────────────────────────────── payloads ─────────────────────────────── */

/**
 * A price tick pushed on `price:tick`. Symbol-scoped, not user-scoped.
 * Mirrors the broker bridge `Quote` (`broker.types.ts`) as it travels over the
 * wire, with both sides optional so a one-sided quote is still valid.
 */
export interface PriceTick {
  symbol: string;
  bid?: number | null;
  ask?: number | null;
  /** Quote time from the bridge: epoch ms (or an ISO string if re-stamped). */
  time?: number | string;
}

/**
 * Mid price when both sides are known. Derived from reported values only — a
 * one-sided or empty quote yields null rather than an invented number.
 */
export function tickMid(tick: PriceTick): number | null {
  const bid = typeof tick.bid === 'number' ? tick.bid : null;
  const ask = typeof tick.ask === 'number' ? tick.ask : null;
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask;
}

/**
 * Delta carried by `trade:opened|updated|closed`.
 *
 * The broker bridge publishes only the fields it actually observed, so every
 * field is optional: absent means "not reported in this event", never zero.
 * A full `PositionDTO` (REST snapshot) satisfies this shape structurally.
 */
export interface PositionUpdate {
  /** Broker event field. */
  positionId?: string;
  /** DTO field (`PositionDTO.id`). */
  id?: string;
  metaApiPositionId?: string | null;
  investmentId?: string | null;
  instrument?: string;
  direction?: string;
  volume?: number;
  entryPrice?: number;
  currentPrice?: number | null;
  exitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  grossPnL?: number;
  /** Bridge spelling of floating P/L. */
  unrealizedPnL?: number;
  /** DTO spelling of floating P/L. */
  floatingPnL?: number;
  netPnL?: number | null;
  commission?: number;
  swap?: number;
  status?: string;
  openedAt?: string;
  closedAt?: string | null;
  /** Broker deal that closed the position, when reported. */
  dealId?: string | null;
}

/** Investment-scoped equity rollup pushed on `account:equity` (broker sync). */
export interface InvestmentEquityUpdate {
  scope: 'investment';
  investmentId: string;
  capitalUsd: number;
  realizedPnL: number;
  unrealizedPnL: number;
  feesDeducted: number;
  currentValUsd: number;
  at: string;
}

/**
 * Connection state pushed on `broker:status`.
 *
 * Two publishers exist: the socket server's own connect handshake
 * (`{ source: 'socket', status: 'CONNECTED' }`) and the broker layer, which
 * either reports `state` (raw bridge state) or a full `status` snapshot. Every
 * field is therefore optional except that at least one state field is present.
 */
export interface BrokerStatusPayload {
  /** 'socket' = this channel's connection, otherwise the broker's own status. */
  source?: string;
  /** Reported status, e.g. 'CONNECTED' | 'DISCONNECTED' | 'ERROR'. */
  status?: string;
  /** Raw bridge state string, e.g. 'DEPLOYED' (the sync worker's spelling). */
  state?: string;
  connected?: boolean;
  accountId?: string;
  brokerName?: string;
  environment?: string;
  balance?: number;
  equity?: number;
  freeMargin?: number;
  currency?: string;
  rawState?: string;
  latencyMs?: number | null;
  at?: string;
}

export interface ServerErrorMessage {
  code: string;
  message: string;
  action?: string;
  room?: string;
}

/** Events the server emits on this namespace. */
export type TradingServerToClientEvents = {
  [WS_EVENTS.positionOpened]: (payload: PositionUpdate) => void;
  [WS_EVENTS.positionUpdated]: (payload: PositionUpdate) => void;
  [WS_EVENTS.positionClosed]: (payload: PositionUpdate) => void;
  [WS_EVENTS.tick]: (payload: PriceTick) => void;
  [WS_EVENTS.equity]: (payload: AccountOverview | InvestmentEquityUpdate) => void;
  [WS_EVENTS.activity]: (payload: ActivityEventDTO) => void;
  [WS_EVENTS.brokerStatus]: (payload: BrokerStatusPayload) => void;
  [WS_EVENTS.error]: (payload: ServerErrorMessage) => void;
};

/** Events this client emits. Both take `{ investmentId }` or a bare id. */
export type TradingClientToServerEvents = {
  [WS_EVENTS.subscribe]: (payload: { investmentId: string }) => void;
  [WS_EVENTS.unsubscribe]: (payload: { investmentId: string }) => void;
};

/** Reserved socket.io lifecycle events we listen to. */
export type TradingLifecycleEvent = 'connect' | 'connect_error' | 'disconnect';

export type TradingInboundEvent = keyof TradingServerToClientEvents | TradingLifecycleEvent;

type TradingListener = (...args: unknown[]) => void;

/**
 * Structural v4 socket surface used by this app. See the header note for why
 * this is declared here instead of imported.
 */
export interface TradingSocket {
  /** Server-assigned socket id, available once connected. */
  readonly id: string;
  readonly connected: boolean;
  /** True while the manager is retrying (used to distinguish errors). */
  readonly active: boolean;
  on(event: TradingInboundEvent, listener: TradingListener): TradingSocket;
  off(event: TradingInboundEvent, listener: TradingListener): TradingSocket;
  emit(event: keyof TradingClientToServerEvents, payload?: unknown): TradingSocket;
  connect(): TradingSocket;
  disconnect(): TradingSocket;
  removeAllListeners(event?: TradingInboundEvent): TradingSocket;
}

/** Shape of the `socket.io-client` module as consumed here. */
interface SocketIoClientRuntime {
  io?: (uri?: string, opts?: Record<string, unknown>) => unknown;
  default?: { io?: (uri?: string, opts?: Record<string, unknown>) => unknown };
}

/* ────────────────────────── token fallback ────────────────────────── */

/**
 * Module-memory only. Never `localStorage`, never a cookie we can read.
 * Cleared on a reload/tab close — which is the point.
 */
let memoryToken: { token: string; expiresAt: number } | null = null;

/** Provide/clear the fallback socket token used in `auth: (cb) => cb(...)`. */
export function setSocketToken(token: string | null, ttlSeconds = 60): void {
  if (!token) {
    memoryToken = null;
    return;
  }
  const ttl = Math.min(Math.max(ttlSeconds, 5), 300);
  memoryToken = { token, expiresAt: Date.now() + ttl * 1000 };
}

function liveToken(): string | null {
  if (!memoryToken) return null;
  if (memoryToken.expiresAt <= Date.now()) {
    memoryToken = null;
    return null;
  }
  return memoryToken.token;
}

function pickString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickNumber(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Fetch a short-lived socket token.
 *
 * Contract: `GET /api/v1/auth/socket-token` → `{ ok: true, data: { token,
 * expiresInSeconds } }` (a bare `{ token }` body is also accepted).
 * OWNED BY THE AUTH MODULE OWNER — while it is unimplemented this returns null
 * and the client simply relies on the httpOnly cookie, which is the preferred
 * path anyway.
 */
export async function fetchSocketToken(): Promise<string | null> {
  try {
    const response = await fetch(SOCKET_TOKEN_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : null;
    const token = pickString(data, 'token') ?? pickString(body, 'token');
    if (!token) return null;

    const ttl = pickNumber(data, 'expiresInSeconds') ?? pickNumber(body, 'expiresInSeconds') ?? 60;
    setSocketToken(token, ttl);
    return token;
  } catch {
    return null;
  }
}

/** True for the generic auth rejection the server sends on a bad handshake. */
export function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauth/i.test(message);
}

/* ─────────────────────────────── connect ─────────────────────────────── */

export interface CreateTradingSocketOptions {
  /** Pre-fetched socket token; omit to use the httpOnly cookie. */
  token?: string | null;
  autoConnect?: boolean;
}

/**
 * Connect to the `/ws/trading` namespace.
 *
 * • `NEXT_PUBLIC_WS_URL` set  → connect straight to the standalone runtime.
 * • otherwise                 → same origin, relying on the reverse proxy that
 *                               maps `/ws/socket.io` to the runtime.
 *
 * `withCredentials: true` is what makes the httpOnly access cookie travel with
 * the handshake; the server reads it from `handshake.headers.cookie`. The auth
 * callback therefore sends `{}` unless a fallback token was fetched.
 *
 * Returns null during SSR (there is no socket on the server).
 */
export function createTradingSocket(options: CreateTradingSocketOptions = {}): TradingSocket | null {
  if (typeof window === 'undefined') return null;
  if (options.token) setSocketToken(options.token);

  const runtime = resolveSocketIoFactory();
  if (!runtime) {
    console.error('[ws] socket.io-client has no `io` factory; realtime updates are off.');
    return null;
  }

  const baseUrl = process.env.NEXT_PUBLIC_WS_URL;

  return runtime(baseUrl ? `${baseUrl}${TRADING_SOCKET_NAMESPACE}` : TRADING_SOCKET_NAMESPACE, {
    path: TRADING_SOCKET_PATH,
    // Start on polling and upgrade: the first connect survives proxies that
    // mangle the WebSocket upgrade, then falls back to a real WebSocket.
    transports: ['polling', 'websocket'],
    withCredentials: true,
    auth: (cb: (data: object) => void) => {
      const token = liveToken();
      cb(token ? { token } : {});
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    reconnectionAttempts: Infinity,
    timeout: 10_000,
    autoConnect: options.autoConnect ?? true,
  }) as TradingSocket;
}

/**
 * Resolve the v4 `io` factory at runtime.
 *
 * The namespace import is typed as the bogus v1 shim (see the header note), so
 * it is narrowed structurally here — and the ESM/CJS interop is handled by
 * accepting the factory either as a named export or as the default export.
 */
function resolveSocketIoFactory(): SocketIoClientRuntime['io'] | null {
  const moduleValue = socketIoClientRuntime as unknown as SocketIoClientRuntime;
  const factory = moduleValue.io ?? moduleValue.default?.io;
  return typeof factory === 'function' ? factory : null;
}

/* ───────────────────────────── type guards ───────────────────────────── */

/**
 * Runtime guards for everything that arrives over the wire: the client must
 * never write an unvalidated shape into React state (and there is no `any`).
 */
export function isPositionDTO(value: unknown): value is PositionDTO {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PositionDTO).id === 'string' &&
    typeof (value as PositionDTO).instrument === 'string' &&
    typeof (value as PositionDTO).volume === 'number' &&
    typeof (value as PositionDTO).status === 'string'
  );
}

export function isActivityEventDTO(value: unknown): value is ActivityEventDTO {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ActivityEventDTO).id === 'string' &&
    typeof (value as ActivityEventDTO).message === 'string' &&
    typeof (value as ActivityEventDTO).severity === 'string'
  );
}

export function isAccountOverview(value: unknown): value is AccountOverview {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AccountOverview).equity === 'number' &&
    typeof (value as AccountOverview).breakdown === 'object' &&
    (value as AccountOverview).breakdown !== null
  );
}

export function isPriceTick(value: unknown): value is PriceTick {
  const tick = value as PriceTick;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof tick.symbol === 'string' &&
    (typeof tick.bid === 'number' || typeof tick.ask === 'number')
  );
}

/**
 * A delta is accepted when it identifies a position — with either the broker's
 * `positionId` or the DTO's `id` — and carries at least one reportable field.
 */
export function isPositionUpdate(value: unknown): value is PositionUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const update = value as PositionUpdate;
  const hasId =
    (typeof update.positionId === 'string' && update.positionId.length > 0) ||
    (typeof update.id === 'string' && update.id.length > 0);
  if (!hasId) return false;
  return (
    typeof update.instrument === 'string' ||
    typeof update.volume === 'number' ||
    typeof update.entryPrice === 'number' ||
    typeof update.currentPrice === 'number' ||
    typeof update.exitPrice === 'number' ||
    typeof update.unrealizedPnL === 'number' ||
    typeof update.floatingPnL === 'number' ||
    typeof update.netPnL === 'number' ||
    typeof update.status === 'string'
  );
}

export function isInvestmentEquityUpdate(value: unknown): value is InvestmentEquityUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const update = value as InvestmentEquityUpdate;
  return (
    typeof update.investmentId === 'string' &&
    typeof update.currentValUsd === 'number' &&
    typeof update.unrealizedPnL === 'number'
  );
}

/** Stable key for a position delta: broker id first, DTO id as fallback. */
export function positionKey(update: PositionUpdate): string | null {
  if (typeof update.positionId === 'string' && update.positionId.length > 0) return update.positionId;
  if (typeof update.id === 'string' && update.id.length > 0) return update.id;
  return null;
}

/**
 * Fold a live delta onto a hydrated `PositionDTO` for rendering.
 *
 * Only values the broker actually reported are copied, so no field can be
 * invented; absent/null deltas leave the snapshot value untouched.
 */
export function applyPositionUpdate(dto: PositionDTO, update: PositionUpdate): PositionDTO {
  const next: PositionDTO = { ...dto };
  if (typeof update.instrument === 'string') next.instrument = update.instrument;
  if (typeof update.direction === 'string') next.direction = update.direction;
  if (typeof update.volume === 'number') next.volume = update.volume;
  if (typeof update.entryPrice === 'number') next.entryPrice = update.entryPrice;
  if (typeof update.currentPrice === 'number') next.currentPrice = update.currentPrice;
  if (typeof update.exitPrice === 'number') next.exitPrice = update.exitPrice;
  if (typeof update.grossPnL === 'number') next.grossPnL = update.grossPnL;
  if (typeof update.unrealizedPnL === 'number') next.floatingPnL = update.unrealizedPnL;
  if (typeof update.floatingPnL === 'number') next.floatingPnL = update.floatingPnL;
  if (typeof update.netPnL === 'number') next.netPnL = update.netPnL;
  if (typeof update.commission === 'number') next.commission = update.commission;
  if (typeof update.swap === 'number') next.swap = update.swap;
  if (typeof update.status === 'string') next.status = update.status;
  if (typeof update.closedAt === 'string') next.closedAt = update.closedAt;
  return next;
}

export function isBrokerStatusPayload(value: unknown): value is BrokerStatusPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as BrokerStatusPayload;
  return (
    typeof payload.status === 'string' ||
    typeof payload.state === 'string' ||
    typeof payload.connected === 'boolean'
  );
}

export function isServerErrorMessage(value: unknown): value is ServerErrorMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ServerErrorMessage).message === 'string'
  );
}
