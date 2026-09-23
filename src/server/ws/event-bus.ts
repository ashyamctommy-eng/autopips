/**
 * WebSocket event bus — the publish side of the trading realtime channel.
 *
 * ── Why Redis pub/sub and not an in-process EventEmitter? ───────────────────
 * The socket.io server cannot live inside Next.js App Router, so it runs as a
 * *separate* Node process (`src/server/main.ts`). Three different places need
 * to push realtime state at the browser:
 *
 *   1. Next.js API routes / server actions   (process A)
 *   2. The bot + broker-sync runtime         (process B, often the socket process)
 *   3. Anything that scales horizontally     (processes A..N behind a LB)
 *
 * An `EventEmitter` only reaches listeners in the *same* process, so a route
 * handler that closes a position could never wake a socket owned by process B.
 * Redis pub/sub gives every publisher one transport and every socket process
 * one subscription, so a fan-out stays correct when either side is scaled,
 * restarted, or deployed separately. It also decouples a trade path from the
 * socket process: publishing is a fire-and-forget Redis command, so a socket
 * restart never blocks a trade.
 *
 * Envelopes are JSON with a discriminated `type` field so a subscriber can
 * switch on the shape without re-parsing the event name, and a `rooms` array
 * so the socket process knows exactly which rooms to target.
 *
 * Contract: publishing is *best effort*. If Redis is unavailable the publish
 * no-ops with a warning — a cache blip must never abort a trade, and a missing
 * live tick is always recoverable from the REST snapshot.
 */

import { WS_EVENTS } from '@/lib/contracts';
import { redis, rkey } from '@/lib/redis';
import type { BotActivity } from '@/server/modules/bot/bot.types';
import type { ActivityEventDTO } from '@/types/api';

/** Redis channel every socket process subscribes to. == 'autopips:ws:events'. */
export const WS_EVENTS_CHANNEL = rkey('ws', 'events');

/** Platform-wide room: broker status + aggregate activity (ADMIN / TRADING_MANAGER only). */
export const ADMIN_ROOM = 'admin';

/** Per-user room, auto-joined by the socket server from verified JWT claims. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Per-investment room, joined only after an ownership check. */
export function investmentRoom(investmentId: string): string {
  return `trading:${investmentId}`;
}

/** Discriminant carried on every envelope. */
export type WsEnvelopeType = 'trade' | 'tick' | 'equity' | 'activity' | 'broker_status';

/**
 * Server -> client events only. The client -> server events
 * (`WS_EVENTS.subscribe` / `WS_EVENTS.unsubscribe`) are deliberately absent:
 * they are handled locally by the socket server and must never be broadcast.
 */
export const WS_SERVER_EVENTS = [
  WS_EVENTS.positionOpened,
  WS_EVENTS.positionUpdated,
  WS_EVENTS.positionClosed,
  WS_EVENTS.tick,
  WS_EVENTS.equity,
  WS_EVENTS.activity,
  WS_EVENTS.brokerStatus,
] as const;

export type WsServerEvent = (typeof WS_SERVER_EVENTS)[number];

/** event name -> discriminant, so `type` is always derived, never hand-set. */
export const WS_EVENT_TYPES = {
  [WS_EVENTS.positionOpened]: 'trade',
  [WS_EVENTS.positionUpdated]: 'trade',
  [WS_EVENTS.positionClosed]: 'trade',
  [WS_EVENTS.tick]: 'tick',
  [WS_EVENTS.equity]: 'equity',
  [WS_EVENTS.activity]: 'activity',
  [WS_EVENTS.brokerStatus]: 'broker_status',
} as const satisfies Record<WsServerEvent, WsEnvelopeType>;

export function isWsServerEvent(value: string): value is WsServerEvent {
  return (WS_SERVER_EVENTS as readonly string[]).includes(value);
}

/** Wire format published to Redis and re-emitted by the socket process. */
export interface WsEnvelope<T = unknown> {
  /** Discriminant — always `WS_EVENT_TYPES[event]`. */
  type: WsEnvelopeType;
  /** socket.io event name to emit, e.g. `trade:opened`. */
  event: WsServerEvent;
  payload: T;
  /** Target rooms. An empty array means "every socket in the namespace". */
  rooms: string[];
  /** Publish time (epoch ms). */
  ts: number;
}

/**
 * Build an envelope with a type derived from the event name.
 * `ts` is injectable so tests and replays are deterministic.
 */
export function envelope<T>(
  event: WsServerEvent,
  payload: T,
  rooms: string[] = [],
  ts: number = Date.now(),
): WsEnvelope<T> {
  return { type: WS_EVENT_TYPES[event], event, payload, rooms: dedupeRooms(rooms), ts };
}

function dedupeRooms(rooms: string[]): string[] {
  const out: string[] = [];
  for (const room of rooms) {
    if (typeof room === 'string' && room.length > 0 && !out.includes(room)) out.push(room);
  }
  return out;
}

/** Parse + validate a raw Redis message. Returns null for anything malformed. */
export function parseEnvelope(raw: string): WsEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Partial<WsEnvelope>;
  if (typeof candidate.event !== 'string' || !isWsServerEvent(candidate.event)) return null;
  if (candidate.type !== WS_EVENT_TYPES[candidate.event]) return null;
  if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) return null;
  if (!Array.isArray(candidate.rooms) || candidate.rooms.some((r) => typeof r !== 'string')) {
    return null;
  }
  return {
    type: candidate.type,
    event: candidate.event,
    payload: candidate.payload,
    rooms: candidate.rooms,
    ts: candidate.ts,
  };
}

/* ──────────────────────────── local dispatch ───────────────────────────── */

type LocalHandler = (env: WsEnvelope) => void;

/**
 * In-process subscribers. `publishLocal` is ONLY for the case where the socket
 * server runs in the *same* process (single-process deployment / tests).
 *
 * Transport contract: a socket server must use exactly ONE transport —
 * either `onLocalDispatch` (in-process) OR the Redis subscription — otherwise
 * an event is delivered twice.
 */
const localHandlers = new Set<LocalHandler>();

/** Register an in-process subscriber. Returns an unsubscribe function. */
export function onLocalDispatch(handler: LocalHandler): () => void {
  localHandlers.add(handler);
  return () => {
    localHandlers.delete(handler);
  };
}

/** Number of registered in-process subscribers (0 in the normal deployment). */
export function localDispatchCount(): number {
  return localHandlers.size;
}

/**
 * Direct, synchronous in-process dispatch. Never throws: one broken subscriber
 * must not break the others or the caller's trade path.
 */
export function publishLocal(env: WsEnvelope): number {
  let delivered = 0;
  for (const handler of localHandlers) {
    try {
      handler(env);
      delivered += 1;
    } catch (err) {
      console.error('[ws-bus] local handler threw:', errorMessage(err));
    }
  }
  return delivered;
}

/* ───────────────────────────── publishing ─────────────────────────────── */

/** Which transport accepted an envelope. `none` means it was dropped. */
export type PublishOutcome = 'local' | 'redis' | 'none';

/** Log spam guard: a down Redis on a busy trade path must not flood stdout. */
const WARN_INTERVAL_MS = 15_000;
const warnedAt = new Map<string, number>();

function warnThrottled(reason: string, detail: string): void {
  const now = Date.now();
  const last = warnedAt.get(reason) ?? 0;
  if (now - last < WARN_INTERVAL_MS) return;
  warnedAt.set(reason, now);
  console.warn(`[ws-bus] publish skipped (${reason}): ${detail}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function publishToRedis(env: WsEnvelope): Promise<boolean> {
  // A cached 'status' check avoids queueing a trade-path event behind a Redis
  // reconnect (ioredis would otherwise buffer it until maxRetriesPerRequest).
  if (redis.status !== 'ready') {
    warnThrottled('redis-unavailable', `status=${redis.status}`);
    return false;
  }
  try {
    await redis.publish(WS_EVENTS_CHANNEL, JSON.stringify(env));
    return true;
  } catch (err) {
    warnThrottled('redis-publish-failed', errorMessage(err));
    return false;
  }
}

/**
 * Publish an already-built envelope: local handlers first (no-op when the
 * socket server is a separate process), then Redis.
 * Never throws.
 */
export async function publishEnvelope(env: WsEnvelope): Promise<PublishOutcome> {
  const local = publishLocal(env) > 0;
  const viaRedis = await publishToRedis(env);
  if (local) return 'local';
  return viaRedis ? 'redis' : 'none';
}

/**
 * Bot activity feed entry. Targets `activity.rooms` (e.g. `trading:<id>`,
 * `admin`). When no rooms are given the entry is delivered to the admin room
 * only — client P/L must never be broadcast to unrelated clients.
 */
export async function publishActivity(activity: BotActivity): Promise<PublishOutcome> {
  const rooms = activity.rooms.length > 0 ? activity.rooms : [ADMIN_ROOM];
  const payload: ActivityEventDTO = {
    id: activity.id,
    action: activity.action,
    message: activity.message,
    severity: activity.severity,
    details: activity.details,
    createdAt: activity.createdAt,
  };
  return publishEnvelope(envelope(WS_EVENTS.activity, payload, rooms));
}

/**
 * Trade lifecycle event (`trade:opened|updated|closed`).
 * Refuses to broadcast when no room is supplied: an un-targeted trade event
 * would leak one client's position to every connected socket.
 */
export async function publishTradeEvent(
  event: string,
  payload: unknown,
  rooms: string[],
): Promise<PublishOutcome> {
  const targets = dedupeRooms(rooms);
  if (targets.length === 0) {
    warnThrottled('trade-event-without-room', `event=${event} refused`);
    return 'none';
  }
  if (!isWsServerEvent(event) || WS_EVENT_TYPES[event] !== 'trade') {
    warnThrottled('unknown-trade-event', `event=${event} refused`);
    return 'none';
  }
  return publishEnvelope(envelope(event, payload, targets));
}

/** Account-level P/L snapshot for one user (`account:equity`). */
export async function publishEquity(userId: string, payload: unknown): Promise<PublishOutcome> {
  if (!userId) {
    warnThrottled('equity-without-user', 'userId missing');
    return 'none';
  }
  return publishEnvelope(envelope(WS_EVENTS.equity, payload, [userRoom(userId)]));
}

/** Broker connection state. Platform-wide, so it goes to the admin room. */
export async function publishBrokerStatus(
  payload: unknown,
  rooms: string[] = [ADMIN_ROOM],
): Promise<PublishOutcome> {
  return publishEnvelope(envelope(WS_EVENTS.brokerStatus, payload, rooms));
}

/**
 * Price tick. Ticks are symbol-scoped, not user-scoped, so the default target
 * is the whole namespace (empty `rooms`); clients filter by symbol.
 */
export async function publishTick(
  payload: unknown,
  rooms: string[] = [],
): Promise<PublishOutcome> {
  return publishEnvelope(envelope(WS_EVENTS.tick, payload, rooms));
}
