import { redis } from '@/lib/redis';

/**
 * Redis-backed bot runtime state: the single-writer lock key and the
 * cross-process heartbeat.
 *
 * WHY THIS FILE EXISTS
 * The loop that trades lives in the WORKER process. The admin console is a WEB
 * process whose in-memory runtime state is permanently empty (`started: false,
 * lockToken: null`), and the worker's `/healthz` may be answered by a replica
 * that never got the lock. Anything an operator or an alert needs to answer
 * "is a worker trading right now" therefore has to come from Redis — one global
 * place both processes can read — not from a module-level variable that only
 * exists in the process that happens to own the loop.
 *
 * Kept free of every heavy import on purpose (only the Redis client): the web
 * route and the worker's health handler both import this file, so pulling in
 * Prisma, the broker adapters or the order manager here would make a status read
 * able to fail for reasons that have nothing to do with status.
 */

/** Redis key holding the single-writer lock (SET NX EX, renewed each tick). */
export const BOT_RUNTIME_LOCK_KEY = 'autopips:lock:bot-runtime';

/** Redis key holding the cross-process heartbeat written by the owning worker. */
export const BOT_RUNTIME_HEARTBEAT_KEY = 'autopips:bot:runtime-heartbeat';

/**
 * A heartbeat must outlive at least three ticks so one slow cycle is not read as
 * "the worker is dead", and never less than this so a 5s interval does not make
 * the key vanish mid-cycle.
 */
export const HEARTBEAT_MIN_TTL_SECONDS = 90;

/** The object written under {@link BOT_RUNTIME_HEARTBEAT_KEY}. */
export interface BotRuntimeHeartbeat {
  /** ISO timestamp of when this runtime acquired the lock. */
  startedAt: string;
  /** ISO timestamp of the last COMPLETED cycle, or null before the first one. */
  lastCycleAt: string | null;
  /** Completed cycles since this runtime started. */
  cycleCount: number;
  intervalSeconds: number;
  enabledStrategies: string[];
  pid: number;
}

/** A heartbeat plus how long ago it was written. */
export interface BotRuntimeHeartbeatRead extends BotRuntimeHeartbeat {
  /**
   * Seconds since the heartbeat was last written. Derived from the key's
   * remaining TTL (see {@link heartbeatTtlSeconds}) rather than a timestamp in
   * the payload: the TTL is refreshed on every write, so `ttl - remaining` is
   * the write age even before the first cycle has completed.
   */
  ageSeconds: number;
}

/** TTL used for the heartbeat key. Exported so writer and reader cannot drift. */
export function heartbeatTtlSeconds(intervalSeconds: number): number {
  return Math.max(3 * intervalSeconds, HEARTBEAT_MIN_TTL_SECONDS);
}

/**
 * Parses a heartbeat value defensively.
 *
 * Returns null for anything that is not a heartbeat: malformed JSON, a JSON
 * scalar, or an object missing the fields a reader relies on. A health probe
 * must treat "unreadable" exactly like "absent" and never throw — an operator
 * screen that 500s because one Redis value is garbage is worse than one that
 * honestly says the worker is not reporting.
 */
export function parseBotRuntimeHeartbeat(raw: string): BotRuntimeHeartbeat | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) return null;
  if (typeof record.intervalSeconds !== 'number' || !Number.isFinite(record.intervalSeconds)) return null;
  if (typeof record.cycleCount !== 'number' || !Number.isFinite(record.cycleCount)) return null;
  if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return null;

  const enabledStrategies = Array.isArray(record.enabledStrategies)
    ? record.enabledStrategies.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    startedAt: record.startedAt,
    lastCycleAt: typeof record.lastCycleAt === 'string' ? record.lastCycleAt : null,
    cycleCount: record.cycleCount,
    intervalSeconds: record.intervalSeconds,
    enabledStrategies,
    pid: record.pid,
  };
}

/**
 * Write age in seconds. `pttlMs` is Redis PTTL: a non-negative value means the
 * key still carries the TTL this module set. `-1` (no expiry) or `-2` (gone)
 * falls back to the newest timestamp in the payload so the reader still gets a
 * number instead of pretending a live worker is absent.
 */
export function heartbeatAgeSeconds(heartbeat: BotRuntimeHeartbeat, pttlMs: number): number {
  if (Number.isFinite(pttlMs) && pttlMs >= 0) {
    return Math.max(0, heartbeatTtlSeconds(heartbeat.intervalSeconds) - pttlMs / 1000);
  }
  const reference = heartbeat.lastCycleAt ?? heartbeat.startedAt;
  const parsed = Date.parse(reference);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / 1000);
}

/**
 * Writes/refreshes the heartbeat. Returns the exact JSON payload on success so
 * the caller can later compare-and-delete only the key it owns, or null when the
 * write failed. A heartbeat failure is NEVER fatal: it is observability, and
 * dropping the trading loop because a status write failed would turn a Redis
 * blip into a stopped platform.
 */
export async function writeBotRuntimeHeartbeat(heartbeat: BotRuntimeHeartbeat): Promise<string | null> {
  const payload = JSON.stringify(heartbeat);
  try {
    await redis.set(
      BOT_RUNTIME_HEARTBEAT_KEY,
      payload,
      'EX',
      heartbeatTtlSeconds(heartbeat.intervalSeconds),
    );
    return payload;
  } catch (err) {
    console.warn(
      '[bot.runtime] heartbeat write failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Removes the heartbeat atomically only when it is still the payload we wrote. */
const CLEAR_HEARTBEAT_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Deletes the heartbeat key.
 *
 * `payload` is the exact JSON this runtime last wrote. The compare-and-delete
 * matters on a lock-lost stop: another replica may already own the loop and have
 * written its own heartbeat, and deleting that would blind the operator to the
 * worker that IS trading. When `payload` is null this runtime never wrote a
 * heartbeat, so there is nothing of ours to remove and we must not touch a key
 * that belongs to another replica.
 */
export async function clearBotRuntimeHeartbeat(payload: string | null): Promise<void> {
  if (payload === null) return;
  try {
    await redis.eval(CLEAR_HEARTBEAT_SCRIPT, 1, BOT_RUNTIME_HEARTBEAT_KEY, payload);
  } catch (err) {
    console.warn(
      '[bot.runtime] heartbeat clear failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Reads ONLY the Redis heartbeat key — no module state, so it is equally valid
 * from the worker and from the web process that has never run the loop.
 *
 * Returns the parsed heartbeat plus its age, or null when the key is absent,
 * unreadable, or malformed. It never throws: callers use it inside health and
 * admin response paths where a throw would take down the very screen an operator
 * keeps open during an incident.
 */
export async function readBotRuntimeHeartbeat(): Promise<BotRuntimeHeartbeatRead | null> {
  let raw: string | null;
  try {
    raw = await redis.get(BOT_RUNTIME_HEARTBEAT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  // A failed TTL read is not a failed heartbeat: fall back to the payload's own
  // timestamps rather than pretending the worker is absent.
  let pttlMs = -1;
  try {
    if (typeof redis.pttl === 'function') pttlMs = await redis.pttl(BOT_RUNTIME_HEARTBEAT_KEY);
  } catch {
    pttlMs = -1;
  }

  const heartbeat = parseBotRuntimeHeartbeat(raw);
  if (!heartbeat) return null;

  return { ...heartbeat, ageSeconds: heartbeatAgeSeconds(heartbeat, pttlMs) };
}
