/**
 * Autopipsz realtime runtime — standalone entrypoint.
 *
 *   npm run dev:ws    (tsx watch)
 *   npm run start:ws  (tsx)
 *
 * Responsibilities, in order:
 *   1. Validate the server environment (fail fast, exit 1).
 *   2. Serve operational HTTP: `GET /healthz` and `POST /internal/publish`.
 *   3. Attach the socket.io server on the `/ws/trading` namespace.
 *   4. Start the bot runtime (and the broker-sync worker) AFTER the socket
 *      server is listening — both are owned by other team members, so a
 *      missing/broken module is a warning, never a crash.
 *   5. Shut down gracefully on SIGTERM/SIGINT.
 *
 * The Next.js app never imports this file; it pushes events with
 * `POST /internal/publish` (Bearer WS_INTERNAL_TOKEN) or by publishing to the
 * Redis channel from `event-bus.ts`.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { serverEnv, type ServerEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { redis, redisSub } from '@/lib/redis';
import { envelope, isWsServerEvent, publishEnvelope } from '@/server/ws/event-bus';
import {
  createTradingSocketServer,
  DEFAULT_SOCKET_PATH,
  TRADING_NAMESPACE,
  type TradingSocketServer,
} from '@/server/ws/socket-server';

/** Request bodies on the internal channel are small envelopes, not uploads. */
const MAX_BODY_BYTES = 64 * 1024;
/** Dependency probes must never make /healthz slow. */
const PROBE_TIMEOUT_MS = 2_000;
/** Graceful shutdown budget before a hard exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/* ────────────────────────────── env ─────────────────────────────── */

/**
 * Load `.env` for local runs. Next.js does this for the web process; a plain
 * `tsx src/server/main.ts` does not. Never overrides a real environment.
 */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  try {
    process.loadEnvFile(path.join(process.cwd(), '.env'));
    console.log('[ws] loaded .env');
  } catch {
    // Optional: the environment may already be populated.
  }
}

/* ──────────────────────────── http helpers ──────────────────────── */

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Constant-time string comparison. Both sides are SHA-256 hashed first so the
 * buffers are always equal-length (timingSafeEqual throws otherwise, and a
 * length check would itself leak the token length).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** `Authorization: Bearer <WS_INTERNAL_TOKEN>`, timing-safe. */
function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const separator = header.indexOf(' ');
  if (separator === -1) return false;
  if (header.slice(0, separator).toLowerCase() !== 'bearer') return false;
  const provided = header.slice(separator + 1).trim();
  if (!provided || !expectedToken) return false;
  return timingSafeEqualString(provided, expectedToken);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        // Stop reading and answer 413 on the same connection: destroying the
        // socket here would deny the caller the reason it was rejected.
        settled = true;
        req.pause();
        reject(new Error(`Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/* ──────────────────────────── health ────────────────────────────── */

type DependencyState = 'ok' | 'error';

interface DependencyReport {
  status: DependencyState;
  latencyMs: number;
  detail: string;
}

/** Rejects (never hangs) when a probe exceeds the budget. */
function raceTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref(),
  );
  // The loser of the race must not become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, timeout]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeRedis(): Promise<DependencyReport> {
  const startedAt = Date.now();
  try {
    const pong = await raceTimeout(redis.ping(), PROBE_TIMEOUT_MS, 'redis PING');
    return {
      status: pong === 'PONG' ? 'ok' : 'error',
      latencyMs: Date.now() - startedAt,
      detail: pong === 'PONG' ? 'PONG' : `unexpected reply: ${String(pong)}`,
    };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - startedAt, detail: errorMessage(err) };
  }
}

async function probeDb(): Promise<DependencyReport> {
  const startedAt = Date.now();
  try {
    await raceTimeout(prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, 'database SELECT 1');
    return { status: 'ok', latencyMs: Date.now() - startedAt, detail: 'SELECT 1' };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - startedAt, detail: errorMessage(err) };
  }
}

/* ──────────────────── internal publish endpoint ─────────────────── */

const publishSchema = z.object({
  event: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  rooms: z.array(z.string().min(1).max(200)).max(200).optional(),
});

async function handleInternalPublish(
  req: IncomingMessage,
  res: ServerResponse,
  env: ServerEnv,
): Promise<void> {
  if (!isAuthorized(req, env.WS_INTERNAL_TOKEN)) {
    // A wrong/missing token is a security event worth logging (never the token).
    console.warn(`[ws] rejected /internal/publish from ${req.socket.remoteAddress ?? 'unknown'}`);
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid internal token.' } });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    // The unread remainder of the body forces a connection close.
    sendJson(
      res,
      413,
      { ok: false, error: { code: 'BAD_REQUEST', message: errorMessage(err) } },
      { connection: 'close' },
    );
    return;
  }

  let json: unknown;
  try {
    json = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body is not valid JSON.' } });
    return;
  }

  const parsed = publishSchema.safeParse(json);
  if (!parsed.success) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Invalid publish payload.', details: parsed.error.issues },
    });
    return;
  }

  const { event, payload, rooms } = parsed.data;
  if (!isWsServerEvent(event)) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: `Event "${event}" is not a broadcastable server event.` },
    });
    return;
  }

  const deliveredVia = await publishEnvelope(envelope(event, payload, rooms ?? []));
  if (deliveredVia === 'none') {
    // Honest failure: the bus is down, the event was NOT delivered.
    sendJson(res, 503, {
      ok: false,
      error: { code: 'INTERNAL', message: 'Event bus unavailable; nothing was published.' },
    });
    return;
  }

  sendJson(res, 202, { ok: true, data: { event, rooms: rooms ?? [], deliveredVia } });
}

/* ─────────────────────── optional runtimes ──────────────────────── */

interface RuntimeHandle {
  name: string;
  stop: () => Promise<void>;
}

interface RuntimeSpec {
  name: string;
  /** Relative module paths, tried in order (source first, then compiled). */
  modules: string[];
  /** Exported starter function names, tried in order. */
  starters: string[];
  /** Exported (optional) stopper function names. */
  stoppers: string[];
}

/**
 * The bot runtime and the broker-sync worker are owned by other team members
 * and may not exist yet, so they are imported lazily and defensively:
 * a missing module or a throwing `start*` logs a warning and the socket server
 * keeps serving. The tsconfig alias (`@/*` -> `src/*`) is resolved to an
 * absolute file URL here on purpose — a literal `import('@/...')` of a module
 * that does not exist yet is a compile error, and this file must stay green
 * whether or not the other teams have landed.
 */
const RUNTIME_SPECS: RuntimeSpec[] = [
  {
    name: 'bot-runtime',
    modules: ['src/server/modules/bot/bot.runtime.ts', 'dist/server/modules/bot/bot.runtime.js'],
    starters: ['startBotRuntime'],
    stoppers: ['stopBotRuntime'],
  },
  {
    name: 'broker-sync',
    modules: [
      'src/server/modules/broker/broker.sync.ts',
      'src/server/modules/broker/broker-sync.ts',
      'dist/server/modules/broker/broker.sync.js',
    ],
    starters: ['startBrokerSync', 'startBrokerSyncWorker'],
    stoppers: ['stopBrokerSync', 'stopBrokerSyncWorker'],
  },
];

interface ModuleLoadFailure {
  ok: false;
  error: string;
}

interface ModuleLoadSuccess {
  ok: true;
  module: Record<string, unknown>;
}

function asCallable(value: unknown): ((...args: unknown[]) => unknown) | null {
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

async function importModule(candidates: string[]): Promise<ModuleLoadSuccess | ModuleLoadFailure> {
  let lastError = 'no candidates';
  for (const relative of candidates) {
    const url = pathToFileURL(path.join(process.cwd(), relative)).href;
    try {
      const loaded = (await import(url)) as Record<string, unknown>;
      return { ok: true, module: loaded };
    } catch (err) {
      lastError = errorMessage(err);
    }
  }
  return { ok: false, error: lastError };
}

async function startRuntime(spec: RuntimeSpec): Promise<RuntimeHandle | null> {
  const loaded = await importModule(spec.modules);
  if (!loaded.ok) {
    console.warn(
      `[ws] ${spec.name} not started (module missing): ${loaded.error}\n` +
        `[ws]   expected one of: ${spec.modules.join(', ')}`,
    );
    return null;
  }

  const starter = spec.starters
    .map((name) => ({ name, fn: asCallable(loaded.module[name]) }))
    .find((entry): entry is { name: string; fn: (...args: unknown[]) => unknown } => entry.fn !== null);

  if (!starter) {
    console.warn(
      `[ws] ${spec.name} module loaded but exports none of [${spec.starters.join(', ')}]; ` +
        `found: ${Object.keys(loaded.module).join(', ') || '(nothing)'}`,
    );
    return null;
  }

  const stopper = spec.stoppers
    .map((name) => asCallable(loaded.module[name]))
    .find((fn): fn is (...args: unknown[]) => unknown => fn !== null);

  const controller = new AbortController();
  try {
    // Tolerates `start*(opts)` and `start()` signatures — the current bot
    // runtime takes no arguments and simply ignores the extra one. The signal
    // is there for a runtime that wants to react to a cooperative stop.
    await starter.fn({ signal: controller.signal });
  } catch (err) {
    console.error(`[ws] ${spec.name} failed to start: ${errorMessage(err)}`);
    return null;
  }

  console.log(`[ws] ${spec.name} started via ${starter.name}()`);
  return {
    name: spec.name,
    stop: async () => {
      controller.abort();
      // Called with no argument on purpose: `stopBotRuntime(reason = 'requested')`
      // takes a string, and passing anything else (an AbortSignal, an options
      // object) lands in its audit payload and fails validation.
      if (stopper) await stopper();
    },
  };
}

/* ──────────────────────── lifecycle helpers ─────────────────────── */

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // A close() on an already-closed server throws ERR_SERVER_NOT_RUNNING
    // asynchronously; the callback contract is what we care about.
  });
}

async function closeRedisClients(): Promise<void> {
  for (const [name, client] of [
    ['redis', redis],
    ['redis-sub', redisSub],
  ] as const) {
    try {
      await client.quit();
    } catch (err) {
      console.warn(`[ws] ${name} quit failed (${errorMessage(err)}); forcing disconnect`);
      try {
        client.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
}

/* ───────────────────────────── boot ─────────────────────────────── */

async function main(): Promise<void> {
  loadDotEnv();

  // 1. Environment first — nothing listens until the contract is satisfied.
  let env: ServerEnv;
  try {
    env = serverEnv();
  } catch (err) {
    console.error('[ws] FATAL: invalid environment.');
    console.error(errorMessage(err));
    process.exit(1);
  }

  const host = env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  const startedAt = new Date().toISOString();

  // 2. Plain HTTP layer: health + internal publish.
  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      const route = url.split('?')[0];

      if (req.method === 'GET' && route === '/healthz') {
        const [db, redisReport] = await Promise.all([probeDb(), probeRedis()]);
        const stats = sockets.getConnectionStats();
        const healthy = db.status === 'ok' && redisReport.status === 'ok';
        sendJson(res, healthy ? 200 : 503, {
          ok: healthy,
          uptime: Number(process.uptime().toFixed(3)),
          connections: stats.sockets,
          rooms: stats.rooms,
          db,
          redis: redisReport,
          namespace: TRADING_NAMESPACE,
          startedAt,
          pid: process.pid,
        });
        return;
      }

      if (req.method === 'POST' && route === '/internal/publish') {
        await handleInternalPublish(req, res, env);
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Use GET /healthz or POST /internal/publish.' },
      });
    })().catch((err: unknown) => {
      console.error(`[ws] HTTP handler failed: ${errorMessage(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Internal error.' } });
      } else {
        res.end();
      }
    });
  });

  // 3. Socket server, attached before listen so no connection is missed.
  const sockets: TradingSocketServer = createTradingSocketServer(httpServer, {
    path: DEFAULT_SOCKET_PATH,
    corsOrigins:
      env.NODE_ENV === 'production'
        ? [env.NEXT_PUBLIC_APP_URL]
        : [env.NEXT_PUBLIC_APP_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
  });
  await sockets.ready;

  await listen(httpServer, env.WS_PORT, host);
  console.log(
    `[ws] listening on http://${host}:${env.WS_PORT} — namespace ${TRADING_NAMESPACE}, ` +
      `path ${DEFAULT_SOCKET_PATH} (${env.NODE_ENV})`,
  );

  // 4. Runtimes start only once sockets are reachable, so the first activity
  //    they publish has a live subscriber.
  const runtimes: RuntimeHandle[] = [];
  for (const spec of RUNTIME_SPECS) {
    const handle = await startRuntime(spec);
    if (handle) runtimes.push(handle);
  }

  let shuttingDown = false;
  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ws] ${reason} — shutting down`);

    const force = setTimeout(() => {
      console.error('[ws] shutdown exceeded its budget; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    for (const runtime of runtimes) {
      try {
        await runtime.stop();
        console.log(`[ws] ${runtime.name} stopped`);
      } catch (err) {
        console.error(`[ws] ${runtime.name} stop failed: ${errorMessage(err)}`);
      }
    }

    try {
      await sockets.close();
    } catch (err) {
      console.error(`[ws] socket close failed: ${errorMessage(err)}`);
    }

    await closeRedisClients();

    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error(`[ws] prisma disconnect failed: ${errorMessage(err)}`);
    }

    await closeHttpServer(httpServer);
    clearTimeout(force);
    console.log('[ws] bye');
    process.exit(exitCode);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  // A crashed callback must not leave a half-dead process serving stale
  // P/L to trading clients; shut down cleanly and let the supervisor restart.
  process.on('uncaughtException', (err) => {
    console.error('[ws] uncaughtException:', err);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[ws] unhandledRejection:', reason);
  });
}

void main().catch((err: unknown) => {
  console.error('[ws] FATAL: startup failed.');
  console.error(err);
  process.exit(1);
});
