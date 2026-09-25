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
 *      missing/broken module is a warning, never a crash. The bot runtime is
 *      supervised: it is retried with backoff if it cannot take the lock, and
 *      restarted if it stops.
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
import { computeTradingStatus, type TradingStatus } from '@/server/modules/bot/bot.runtime.health';
import { readBotRuntimeHeartbeat } from '@/server/modules/bot/bot.runtime.state';
// Type-only import: erased at compile time, so main.ts still boots when the bot
// runtime module itself is missing or broken (see RUNTIME_SPECS below).
import type { BotRuntimeStatus } from '@/server/modules/bot/bot.runtime';

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

/**
 * Builds the `trading` block of `/healthz`.
 *
 * Prefers the in-process `botRuntimeStatus()` — a fresh lock read plus the live
 * cycle counters — and falls back to the Redis heartbeat, the same cross-process
 * truth the admin API reads, for anything the runtime cannot report. Never
 * throws: a health endpoint that fails because the thing it is checking is broken
 * is useless to the operator staring at it.
 */
async function collectTradingStatus(
  botRuntimeModule: Record<string, unknown> | null,
  fallbackIntervalSeconds: number,
): Promise<TradingStatus> {
  const heartbeat = await readBotRuntimeHeartbeat();
  const statusFn = botRuntimeModule ? asCallable(botRuntimeModule.botRuntimeStatus) : null;

  let status: BotRuntimeStatus | null = null;
  if (statusFn) {
    try {
      status = (await statusFn()) as BotRuntimeStatus;
    } catch (err) {
      console.warn(`[ws] botRuntimeStatus() failed: ${errorMessage(err)}`);
    }
  }

  return computeTradingStatus({
    started: status?.started ?? false,
    lockHeld: status?.lockHeld ?? false,
    startedAt: status?.startedAt ?? heartbeat?.startedAt ?? null,
    lastCycleAt: status?.lastCycleAt ?? heartbeat?.lastCycleAt ?? null,
    cycleCount: status?.cycleCount ?? heartbeat?.cycleCount ?? 0,
    intervalSeconds: status?.intervalSeconds || heartbeat?.intervalSeconds || fallbackIntervalSeconds,
    enabledStrategies: status?.enabledStrategies ?? heartbeat?.enabledStrategies ?? [],
    reason: status?.reason ?? (botRuntimeModule ? null : 'bot runtime module is not loaded yet'),
    heartbeatAgeSeconds: heartbeat?.ageSeconds ?? null,
    nowMs: Date.now(),
  });
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

interface StoppableRuntime {
  name: string;
  stop: () => Promise<void>;
}

/** Result of one attempt to start a runtime. */
type RuntimeStartOutcome = { started: true } | { started: false; reason: string };

interface RuntimeHandle extends StoppableRuntime {
  /**
   * Calls the resolved starter. Safe to call repeatedly — the supervisor does —
   * and never throws: a throwing starter becomes `{ started: false, reason }`.
   */
  start: () => Promise<RuntimeStartOutcome>;
  /** The lazily loaded module, kept for read-only introspection (health). */
  module: Record<string, unknown>;
}

interface RuntimeSpec {
  name: string;
  /** Relative module paths, tried in order (source first, then compiled). */
  modules: string[];
  /** Exported starter function names, tried in order. */
  starters: string[];
  /** Exported (optional) stopper function names. */
  stoppers: string[];
  /**
   * True when the runtime can refuse to start (or stop itself later) and must be
   * retried. main.ts runs exactly one supervisor loop per supervised spec.
   */
  supervised?: boolean;
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
    // The bot runtime is the whole point of this process and it can legitimately
    // refuse to start (lock held by the outgoing replica) or stop itself (lock
    // lost). One supervisor loop keeps retrying it for the life of the process.
    supervised: true,
  },
  // There is deliberately NO standalone 'broker-sync' runtime registered here.
  //
  // `broker.sync.ts` exports `runSyncCycle()` — a ONE-SHOT tick, not a loop — and
  // `bot.runtime.ts` calls it unconditionally at the top of every cycle. Broker
  // balances, positions and deal closures therefore sync on
  // `BROKER_SYNC_INTERVAL` for as long as the bot runtime is alive, including
  // when zero strategies are enabled. That is the intended ownership.
  //
  // Registering a second, independent sync loop here would run two writers
  // against the same `TradeRecord`/`Investment` rows on the same cadence and
  // race the bot, so it is not done. If sync ever needs to survive a stopped bot
  // runtime, add a `startBrokerSync()` to `broker.sync.ts` behind the SAME
  // single-writer Redis lock pattern used by `bot.runtime.ts` (SET NX + TTL +
  // renew + release-if-owned) and list it here — do not just wrap the tick.
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

async function loadRuntime(spec: RuntimeSpec): Promise<RuntimeHandle | null> {
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

  return {
    name: spec.name,
    module: loaded.module,
    start: async (): Promise<RuntimeStartOutcome> => {
      try {
        // Tolerates `start*(opts)` and `start()` signatures — the current bot
        // runtime takes no arguments and simply ignores the extra one. The signal
        // is there for a runtime that wants to react to a cooperative stop.
        const result = await starter.fn({ signal: controller.signal });
        // Starters that report their outcome return `{ started, reason }`
        // (startBotRuntime does). Anything else that returns without throwing is
        // treated as started, which keeps this generic for other runtimes.
        if (result !== null && typeof result === 'object' && 'started' in (result as object)) {
          const outcome = result as { started?: unknown; reason?: unknown };
          if (outcome.started === false) {
            return {
              started: false,
              reason:
                typeof outcome.reason === 'string' && outcome.reason.length > 0
                  ? outcome.reason
                  : 'the starter declined to run',
            };
          }
        }
        return { started: true };
      } catch (err) {
        return { started: false, reason: `START_THREW: ${errorMessage(err)}` };
      }
    },
    stop: async () => {
      controller.abort();
      // Called with no argument on purpose: `stopBotRuntime(reason = 'requested')`
      // takes a string, and passing anything else (an AbortSignal, an options
      // object) lands in its audit payload and fails validation.
      if (stopper) await stopper();
    },
  };
}

/** Retry schedule for a supervised runtime: 5s, 10s, 20s, 40s, then 60s forever. */
const RUNTIME_RETRY_BASE_MS = 5_000;
const RUNTIME_RETRY_MAX_MS = 60_000;
/** How often a running supervised runtime is checked for a silent stop. */
const RUNTIME_WATCH_INTERVAL_MS = 5_000;

function runtimeRetryDelayMs(attempt: number): number {
  return Math.min(RUNTIME_RETRY_BASE_MS * 2 ** Math.max(0, attempt), RUNTIME_RETRY_MAX_MS);
}

/** Reads the runtime's own `botRuntimeStatus()`, or null when it exports none. */
async function readRuntimeStatus(
  handle: RuntimeHandle,
): Promise<{ started: boolean; reason?: string } | null> {
  const statusFn = asCallable(handle.module.botRuntimeStatus);
  if (!statusFn) return null;
  try {
    const status = (await statusFn()) as { started?: unknown; reason?: unknown };
    return {
      started: status.started === true,
      reason: typeof status.reason === 'string' ? status.reason : undefined,
    };
  } catch (err) {
    console.warn(`[ws] ${handle.name} status read failed: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Supervises ONE runtime with ONE loop.
 *
 * WHY: `startBotRuntime()` returns `{ started: false, reason: 'LOCK_HELD' }`
 * during a rolling deploy (the outgoing replica can hold the lock for up to its
 * 60s TTL) and stops itself permanently on lock loss. The old code called the
 * starter exactly once, so both cases left the worker serving sockets and a green
 * `/healthz` while placing zero trades forever. This loop retries with
 * exponential backoff until a start succeeds, then watches for a silent stop and
 * resumes the same retry loop.
 *
 * SAFETY: exactly one loop per runtime, and it never has two start attempts in
 * flight — the next attempt is scheduled only after the previous one finished
 * (`pause` is awaited inside the single async loop; there are no concurrent
 * timers that could both call `handle.start()`). Two runtimes trading at once
 * would double every client's exposure, so this invariant matters more than
 * latency.
 */
function superviseRuntime(
  handle: RuntimeHandle,
  readStatus: () => Promise<{ started: boolean; reason?: string } | null>,
): StoppableRuntime {
  let stopped = false;
  let wake: (() => void) | null = null;
  let attempt = 0;

  /** Sleep that `stop()` interrupts immediately, so shutdown is not delayed. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const outcome = await handle.start();
      if (stopped) return;

      if (outcome.started) {
        attempt = 0;
        console.info(`[ws] ${handle.name} started via the boot supervisor`);
        // A successful start is not a promise to keep running: the bot runtime
        // stops itself when it loses the Redis lock. Poll its own status until it
        // reports stopped, then loop around and start it again.
        while (!stopped) {
          await pause(RUNTIME_WATCH_INTERVAL_MS);
          if (stopped) return;
          const status = await readStatus();
          if (status && !status.started) {
            console.warn(
              `[ws] ${handle.name} stopped after a successful start ` +
                `(${status.reason ?? 'no reason reported'}); restarting.`,
            );
            break;
          }
        }
        continue;
      }

      const delayMs = runtimeRetryDelayMs(attempt);
      attempt += 1;
      // console.error, not warn: a runtime that cannot start is a platform that
      // is not trading, and the old code logged this once and then went silent.
      console.error(
        `[ws] ${handle.name} did NOT start (${outcome.reason}); attempt ${attempt} failed, ` +
          `retrying in ${Math.round(delayMs / 1000)}s. Trading is stopped until it succeeds.`,
      );
      await pause(delayMs);
    }
  }

  void loop().catch((err: unknown) => {
    // The loop handles its own expected failures; reaching here means a bug.
    console.error(`[ws] ${handle.name} supervisor crashed: ${errorMessage(err)}`);
  });

  return {
    name: handle.name,
    stop: async () => {
      stopped = true;
      wake?.();
      await handle.stop();
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

/**
 * Port to bind. Prefers the platform-injected `PORT`, then the configured
 * `WS_PORT`. An unparseable value is ignored rather than crashing — a bad
 * `PORT` should not take the realtime tier down outright.
 */
function resolveListenPort(env: ServerEnv): number {
  const injected = Number(process.env.PORT);
  if (Number.isInteger(injected) && injected > 0 && injected < 65536) return injected;
  return env.WS_PORT;
}

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

  // Set once the bot-runtime module has been lazily loaded (see step 4). Health
  // reads its status from here rather than importing the module statically, which
  // preserves the defensive lazy-import behaviour below.
  let botRuntimeModule: Record<string, unknown> | null = null;

  // 2. Plain HTTP layer: health + internal publish.
  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      const route = url.split('?')[0];

      if (req.method === 'GET' && route === '/healthz') {
        const [db, redisReport] = await Promise.all([probeDb(), probeRedis()]);
        const trading = await collectTradingStatus(botRuntimeModule, env.BROKER_SYNC_INTERVAL);
        const stats = sockets.getConnectionStats();
        const infraHealthy = db.status === 'ok' && redisReport.status === 'ok';
        // WHY THE HTTP CODE DOES NOT FOLLOW THE BOT: Railway's healthcheck points
        // at /healthz and restarts the container on a non-2xx. A worker that
        // legitimately does NOT own the lock — the normal case during a rolling
        // deploy, while the outgoing replica still holds it — would then be
        // restarted in a loop and could never take over. Postgres + Redis being up
        // is therefore the only thing this endpoint asserts with a 2xx; `trading`
        // carries the bot truth, and `?strict=1` turns any non-'ok' trading status
        // into a 503 for monitors that want a hard alert (never the platform's own
        // healthcheck).
        const strict = new URL(url, 'http://localhost').searchParams.get('strict') === '1';
        const statusCode = !infraHealthy || (strict && trading.status !== 'ok') ? 503 : 200;
        sendJson(res, statusCode, {
          ok: infraHealthy,
          uptime: Number(process.uptime().toFixed(3)),
          connections: stats.sockets,
          rooms: stats.rooms,
          db,
          redis: redisReport,
          trading,
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

  // Managed hosts (Railway, Render, Fly, Heroku) inject the port to bind as
  // `PORT` and route the public domain to it — ignoring it means the service is
  // unreachable on the platform's edge. `WS_PORT` remains the local/default
  // fallback so the documented `npm run dev:ws` behaviour is unchanged.
  const port = resolveListenPort(env);
  await listen(httpServer, port, host);
  console.log(
    `[ws] listening on http://${host}:${port} — namespace ${TRADING_NAMESPACE}, ` +
      `path ${DEFAULT_SOCKET_PATH} (${env.NODE_ENV})`,
  );
  console.log(
    `[ws] broker sync is driven by the bot runtime cycle (every ${env.BROKER_SYNC_INTERVAL}s), not a separate loop.`,
  );

  // 4. Runtimes start only once sockets are reachable, so the first activity
  //    they publish has a live subscriber. The bot runtime is SUPERVISED: one
  //    loop keeps retrying it after a held-lock refusal or a lock-lost stop, so a
  //    rolling deploy or a Redis flush cannot leave the platform silently idle.
  const runtimes: StoppableRuntime[] = [];
  for (const spec of RUNTIME_SPECS) {
    const handle = await loadRuntime(spec);
    if (!handle) continue;
    if (spec.name === 'bot-runtime') botRuntimeModule = handle.module;
    if (spec.supervised) {
      runtimes.push(superviseRuntime(handle, () => readRuntimeStatus(handle)));
    } else {
      const outcome = await handle.start();
      if (outcome.started) runtimes.push(handle);
      else console.error(`[ws] ${spec.name} failed to start: ${outcome.reason}`);
    }
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
