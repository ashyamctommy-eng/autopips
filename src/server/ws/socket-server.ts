/**
 * Trading socket server (socket.io).
 *
 * Runs in the standalone Node process (`src/server/main.ts`) and attaches to a
 * plain `node:http` server — never to Next.js. It is the ONLY component that
 * talks to browsers over a socket; everything else pushes through
 * `event-bus.ts` (Redis pub/sub) or `POST /internal/publish`.
 *
 * Namespace: `/ws/trading` (fixed by the product spec).
 *
 * Security model (see also `docs`-free comments below):
 *   • The JWT comes from the handshake only — `handshake.auth.token`, or the
 *     httpOnly access cookie the browser sends with `withCredentials: true`.
 *     A query-string token is explicitly ignored (it leaks into access logs,
 *     proxy logs and browser history).
 *   • `userId` / `role` are derived from the *verified* claims. A
 *     client-supplied `userId` in the auth payload is never read.
 *   • Every socket auto-joins `user:<userId>`; ADMIN/TRADING_MANAGER also join
 *     `admin`. No other room can be joined without an ownership check.
 */

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIoServer, type Namespace, type Socket } from 'socket.io';
import { z } from 'zod';
import type { Role } from '@prisma/client';

import { WS_EVENTS } from '@/lib/contracts';
import { prisma } from '@/lib/prisma';
import { redisSub } from '@/lib/redis';
import {
  ACCESS_COOKIE,
  isSessionRevoked,
  verifyAccessToken,
} from '@/server/modules/auth/token.service';

import {
  ADMIN_ROOM,
  WS_EVENTS_CHANNEL,
  investmentRoom,
  onLocalDispatch,
  parseEnvelope,
  userRoom,
  type WsEnvelope,
} from './event-bus';

/** The namespace path is part of the wire contract — do not change it. */
export const TRADING_NAMESPACE = '/ws/trading';

/**
 * engine.io HTTP path. Kept identical on the client (`socket-client.ts`) so the
 * same config works both same-origin behind a reverse proxy and when
 * `NEXT_PUBLIC_WS_URL` points straight at this process.
 */
export const DEFAULT_SOCKET_PATH = '/ws/socket.io';

/** Client -> server message budget: 30 subscribe/unsubscribe per 10s per socket. */
export const MESSAGE_RATE_LIMIT = { max: 30, windowMs: 10_000 } as const;

/** Hard cap on simultaneously joined investment rooms per socket. */
const MAX_JOINED_ROOMS = 20;

/** Heartbeat tuned for a trading UI: a dead tab is noticed in ~45s worst case. */
const DEFAULT_PING_INTERVAL_MS = 20_000;
const DEFAULT_PING_TIMEOUT_MS = 25_000;

type ClientEvents = Record<string, (...args: unknown[]) => void>;
type ServerEvents = Record<string, (...args: unknown[]) => void>;
type InterServerEvents = Record<string, never>;

/** Verified identity, derived from the JWT. Never from the client payload. */
export interface SocketAuth {
  userId: string;
  role: Role;
  email: string;
  /** Session id — lets us reject a revoked session at connect time. */
  sessionId: string;
}

interface MessageWindow {
  startedAt: number;
  count: number;
}

/** State attached to each socket. `subscriptions` memoises room decisions. */
export interface SocketData {
  auth: SocketAuth;
  /** room -> allowed. Populated once, at subscribe time. */
  subscriptions: Map<string, boolean>;
  messageWindow: MessageWindow;
}

type TradingSocket = Socket<ClientEvents, ServerEvents, InterServerEvents, SocketData>;
type TradingNamespace = Namespace<ClientEvents, ServerEvents, InterServerEvents, SocketData>;

export interface TradingSocketServerOptions {
  /** engine.io path. Defaults to `/ws/socket.io`. */
  path?: string;
  /** Allowed browser origins. Defaults to the app origin (+ localhost in dev). */
  corsOrigins?: string[];
  /**
   * `true` when publishers live in this very process: subscribe to the local
   * bus instead of Redis. Never use both transports at once.
   */
  inProcess?: boolean;
  pingInterval?: number;
  pingTimeout?: number;
}

export interface ConnectionStats {
  /** Live sockets in the `/ws/trading` namespace. */
  sockets: number;
  /** room name -> member count (private per-socket rooms are excluded). */
  rooms: Record<string, number>;
}

export interface TradingSocketServer {
  io: SocketIoServer<ClientEvents, ServerEvents, InterServerEvents, SocketData>;
  namespace: TradingNamespace;
  /** Resolves once the bus transport is wired up. Never rejects. */
  ready: Promise<void>;
  getConnectionStats(): ConnectionStats;
  close(): Promise<void>;
}

function isPrivileged(role: Role): boolean {
  return role === 'ADMIN' || role === 'TRADING_MANAGER';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Extract the access token from the handshake.
 * Order: `auth.token` (explicit, used by the socket-token fallback) then the
 * httpOnly access cookie. A `?token=` query parameter is ignored on purpose.
 */
function extractToken(socket: TradingSocket): string | null {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  const fromAuth = auth && typeof auth.token === 'string' ? auth.token.trim() : '';
  if (fromAuth) return fromAuth;

  const fromCookie = readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
  if (fromCookie) return fromCookie;

  return null;
}

/** Verify the handshake and derive the identity. Throws on any failure. */
async function authenticateSocket(socket: TradingSocket): Promise<SocketAuth> {
  if (socket.handshake.query.token !== undefined) {
    // Do not consume it — log it as a smell so the client gets fixed.
    console.warn(
      `[ws] connection ${socket.id} presented a query-string token; ignored (use auth.token or the httpOnly cookie).`,
    );
  }

  const token = extractToken(socket);
  if (!token) throw new Error('unauthorized: no access token in handshake');

  // `verifyAccessToken` checks signature, issuer, audience, algorithm + expiry.
  const claims = await verifyAccessToken(token);

  const sessionId = typeof claims.sid === 'string' ? claims.sid : '';
  if (sessionId && (await isSessionRevoked(sessionId))) {
    throw new Error('unauthorized: session revoked');
  }

  return {
    userId: String(claims.sub),
    role: claims.role,
    email: typeof claims.email === 'string' ? claims.email : '',
    sessionId,
  };
}

/** Payload accepted by `trading:subscribe` / `trading:unsubscribe`. */
const roomRequestSchema = z.union([
  z.string().min(1).max(200),
  z
    .object({
      investmentId: z.string().min(1).max(200).optional(),
      room: z.string().min(1).max(200).optional(),
    })
    .refine((v) => Boolean(v.investmentId) !== Boolean(v.room), {
      message: 'Provide exactly one of investmentId or room.',
    }),
]);

/**
 * Normalise a subscribe payload to a room name.
 * A bare string without a ":" is treated as an investment id.
 */
function resolveRoom(payload: unknown): string | null {
  const parsed = roomRequestSchema.safeParse(payload);
  if (!parsed.success) return null;

  if (typeof parsed.data === 'string') {
    const value = parsed.data.trim();
    if (!value) return null;
    return value.includes(':') ? value : investmentRoom(value);
  }
  const investmentId = parsed.data.investmentId?.trim();
  if (investmentId) return investmentRoom(investmentId);
  const room = parsed.data.room?.trim();
  return room ?? null;
}

/**
 * Room authorization.
 *
 *   `trading:<investmentId>` -> Prisma ownership check (or a privileged role),
 *                               memoised on the socket so a flapping client
 *                               cannot turn reconnects into a query flood.
 *   anything else            -> DENIED. Notably `user:<other-id>` and `admin`
 *                               can never be requested by a client.
 *
 * Fails CLOSED: if the ownership query errors, the join is refused.
 */
async function authorizeRoom(socket: TradingSocket, room: string): Promise<boolean> {
  const cached = socket.data.subscriptions.get(room);
  if (cached !== undefined) return cached;

  let allowed = false;

  if (room.startsWith('trading:')) {
    const investmentId = room.slice('trading:'.length);
    if (!investmentId) {
      allowed = false;
    } else if (isPrivileged(socket.data.auth.role)) {
      // Admins/managers may watch any investment; no ownership query needed.
      allowed = true;
    } else {
      try {
        const investment = await prisma.investment.findUnique({
          where: { id: investmentId },
          select: { userId: true },
        });
        allowed = investment !== null && investment.userId === socket.data.auth.userId;
      } catch (err) {
        console.error(`[ws] ownership check failed for ${room}: ${errorMessage(err)}`);
        allowed = false;
      }
    }
  }

  socket.data.subscriptions.set(room, allowed);
  return allowed;
}

function emitSocketError(
  socket: TradingSocket,
  code: 'BAD_REQUEST' | 'FORBIDDEN' | 'RATE_LIMITED',
  message: string,
  action: string,
  room?: string,
): void {
  socket.emit(WS_EVENTS.error, { code, message, action, ...(room ? { room } : {}) });
}

/** Sliding-free fixed window per socket. Returns false when the budget is spent. */
function withinRateLimit(socket: TradingSocket): boolean {
  const now = Date.now();
  const window = socket.data.messageWindow;
  if (now - window.startedAt >= MESSAGE_RATE_LIMIT.windowMs) {
    window.startedAt = now;
    window.count = 1;
    return true;
  }
  window.count += 1;
  return window.count <= MESSAGE_RATE_LIMIT.max;
}

function resolveCorsOrigins(options: TradingSocketServerOptions): string[] {
  if (options.corsOrigins && options.corsOrigins.length > 0) return options.corsOrigins;
  if (process.env.NODE_ENV === 'production') {
    return [process.env.NEXT_PUBLIC_APP_URL ?? 'https://autopips.pro'];
  }
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://autopips.pro',
  ];
}

/**
 * Create and attach the trading socket server.
 *
 * Synchronous by design so `main.ts` can attach it before `listen()`; the bus
 * wiring is exposed as `.ready` for callers that want to await it.
 */
export function createTradingSocketServer(
  httpServer: HttpServer,
  options: TradingSocketServerOptions = {},
): TradingSocketServer {
  const inProcess = options.inProcess === true;

  const io = new SocketIoServer<ClientEvents, ServerEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      path: options.path ?? process.env.WS_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
      serveClient: false,
      // Ping/pong keepalive: fast enough that a frozen trading UI reconnects.
      pingInterval: options.pingInterval ?? DEFAULT_PING_INTERVAL_MS,
      pingTimeout: options.pingTimeout ?? DEFAULT_PING_TIMEOUT_MS,
      cors: { origin: resolveCorsOrigins(options), credentials: true },
      maxHttpBufferSize: 1e6,
    },
  );

  const namespace = io.of(TRADING_NAMESPACE);
  namespace.use((socket, next) => {
    void (async () => {
      try {
        const auth = await authenticateSocket(socket);
        socket.data.auth = auth;
        socket.data.subscriptions = new Map<string, boolean>();
        socket.data.messageWindow = { startedAt: Date.now(), count: 0 };
        next();
      } catch (err) {
        // Log the real reason, tell the client only that it failed.
        console.warn(
          `[ws] rejected connection ${socket.id} (${socket.handshake.address}): ${errorMessage(err)}`,
        );
        next(new Error('unauthorized'));
      }
    })();
  });

  /** Last broker status seen on the bus, replayed to every new connection. */
  let lastBrokerStatus: unknown = null;

  function emitToRooms(env: WsEnvelope): void {
    if (env.event === WS_EVENTS.brokerStatus) lastBrokerStatus = env.payload;
    if (env.rooms.length === 0) {
      // No target rooms -> namespace-wide (used by price ticks).
      namespace.emit(env.event, env.payload);
      return;
    }
    for (const room of env.rooms) {
      namespace.to(room).emit(env.event, env.payload);
    }
  }

  let detachLocal: (() => void) | null = null;
  let onRedisMessage: ((channel: string, message: string) => void) | null = null;
  let ready: Promise<void>;

  if (inProcess) {
    // Same-process publishers: dispatch directly, no Redis round trip.
    detachLocal = onLocalDispatch(emitToRooms);
    ready = Promise.resolve();
  } else {
    onRedisMessage = (channel: string, message: string) => {
      if (channel !== WS_EVENTS_CHANNEL) return;
      const env = parseEnvelope(message);
      if (!env) {
        console.warn('[ws] dropped malformed envelope from the bus.');
        return;
      }
      emitToRooms(env);
    };
    redisSub.on('message', onRedisMessage);
    ready = redisSub
      .subscribe(WS_EVENTS_CHANNEL)
      .then(() => {
        console.log(`[ws] subscribed to ${WS_EVENTS_CHANNEL}`);
      })
      .catch((err: unknown) => {
        // Not fatal: sockets still connect and the REST snapshot is the
        // fallback. ioredis retries the subscription when Redis returns.
        console.error(`[ws] could not subscribe to ${WS_EVENTS_CHANNEL}: ${errorMessage(err)}`);
      });
  }

  namespace.on('connection', (socket) => {
    const auth = socket.data.auth;
    socket.join(userRoom(auth.userId));
    if (isPrivileged(auth.role)) socket.join(ADMIN_ROOM);

    console.log(
      `[ws] +${socket.id} user=${auth.userId} role=${auth.role} sockets=${namespace.sockets.size}`,
    );

    // The dashboard needs a broker/connection state the moment it loads, so
    // replay it before any subscription round trip.
    socket.emit(WS_EVENTS.brokerStatus, {
      source: 'socket',
      status: 'CONNECTED',
      connected: true,
      socketId: socket.id,
      userId: auth.userId,
      role: auth.role,
      at: new Date().toISOString(),
    });
    if (lastBrokerStatus !== null) {
      // Last known broker state from the bus; the client treats the later
      // payload as authoritative.
      socket.emit(WS_EVENTS.brokerStatus, lastBrokerStatus);
    }

    socket.on(WS_EVENTS.subscribe, (payload: unknown, ack?: unknown) => {
      void (async () => {
        if (!withinRateLimit(socket)) {
          console.warn(`[ws] rate limit exceeded by ${socket.id} — disconnecting`);
          emitSocketError(socket, 'RATE_LIMITED', 'Too many subscription requests.', 'subscribe');
          socket.disconnect(true);
          return;
        }

        const room = resolveRoom(payload);
        if (!room) {
          emitSocketError(socket, 'BAD_REQUEST', 'Invalid subscription payload.', 'subscribe');
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, code: 'BAD_REQUEST' });
          return;
        }

        if (socket.rooms.size >= MAX_JOINED_ROOMS + 2 /* self + user room */) {
          emitSocketError(socket, 'FORBIDDEN', 'Room limit reached.', 'subscribe', room);
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, code: 'FORBIDDEN', room });
          return;
        }

        if (!(await authorizeRoom(socket, room))) {
          emitSocketError(
            socket,
            'FORBIDDEN',
            'You are not authorized to subscribe to this room.',
            'subscribe',
            room,
          );
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, code: 'FORBIDDEN', room });
          return;
        }

        await socket.join(room);
        if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: true, room });
      })();
    });

    socket.on(WS_EVENTS.unsubscribe, (payload: unknown, ack?: unknown) => {
      void (async () => {
        if (!withinRateLimit(socket)) {
          console.warn(`[ws] rate limit exceeded by ${socket.id} — disconnecting`);
          emitSocketError(socket, 'RATE_LIMITED', 'Too many subscription requests.', 'unsubscribe');
          socket.disconnect(true);
          return;
        }

        const room = resolveRoom(payload);
        if (!room) {
          emitSocketError(socket, 'BAD_REQUEST', 'Invalid unsubscribe payload.', 'unsubscribe');
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, code: 'BAD_REQUEST' });
          return;
        }

        // Auto-joined rooms carry the user's own P/L; leaving them would
        // silently kill the dashboard, so the request is refused.
        if (room === userRoom(socket.data.auth.userId) || room === ADMIN_ROOM) {
          emitSocketError(socket, 'FORBIDDEN', 'Cannot leave an auto-joined room.', 'unsubscribe', room);
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: false, code: 'FORBIDDEN', room });
          return;
        }

        socket.data.subscriptions.delete(room);
        await socket.leave(room);
        if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: true, room });
      })();
    });

    socket.on('disconnect', (reason: unknown) => {
      console.log(`[ws] -${socket.id} (${String(reason)}) sockets=${namespace.sockets.size}`);
    });
  });

  function getConnectionStats(): ConnectionStats {
    const rooms: Record<string, number> = {};
    for (const [room, members] of namespace.adapter.rooms) {
      // socket.io creates a private room per socket id; not useful on a screen.
      if (namespace.sockets.has(room)) continue;
      rooms[room] = members.size;
    }
    return { sockets: namespace.sockets.size, rooms };
  }

  async function close(): Promise<void> {
    if (detachLocal) {
      detachLocal();
      detachLocal = null;
    }
    if (onRedisMessage) {
      redisSub.off('message', onRedisMessage);
      onRedisMessage = null;
      try {
        await redisSub.unsubscribe(WS_EVENTS_CHANNEL);
      } catch (err) {
        console.warn(`[ws] unsubscribe failed: ${errorMessage(err)}`);
      }
    }
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
  }

  return { io, namespace, ready, getConnectionStats, close };
}
