import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BOT RUNTIME HEARTBEAT — the cross-process truth.
 *
 * The web replica that serves the admin console has an empty in-memory runtime
 * state, so "is a worker trading" is answered from this Redis key alone. The
 * contract pinned here is therefore a FAIL-SAFE one: absent, unreadable or
 * malformed data must come back as `null`, never as a throw and never as a
 * fabricated heartbeat. A health screen that 500s during an incident is worse
 * than one that honestly says the worker is not reporting.
 */

const mocks = vi.hoisted(() => {
  interface Entry {
    value: string;
    /** Absolute epoch ms, or null for a key with no expiry. */
    expiresAt: number | null;
  }
  return {
    store: new Map<string, Entry>(),
    redisFails: false,
    pttlFails: false,
  };
});

vi.mock('@/lib/redis', () => ({
  redis: {
    async set(key: string, value: string, mode?: string, ttlSeconds?: number) {
      const expiresAt =
        mode === 'EX' && typeof ttlSeconds === 'number' ? Date.now() + ttlSeconds * 1000 : null;
      mocks.store.set(key, { value, expiresAt });
      return 'OK';
    },
    async get(key: string) {
      if (mocks.redisFails) throw new Error('redis down');
      const entry = mocks.store.get(key);
      return entry ? entry.value : null;
    },
    async pttl(key: string) {
      if (mocks.pttlFails) throw new Error('pttl down');
      const entry = mocks.store.get(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, entry.expiresAt - Date.now());
    },
    async eval(_script: string, _numKeys: number, key: string, payload: string) {
      const entry = mocks.store.get(key);
      if (entry && entry.value === payload) {
        mocks.store.delete(key);
        return 1;
      }
      return 0;
    },
    async del(key: string) {
      return mocks.store.delete(key) ? 1 : 0;
    },
  },
}));

import {
  BOT_RUNTIME_HEARTBEAT_KEY,
  clearBotRuntimeHeartbeat,
  heartbeatTtlSeconds,
  parseBotRuntimeHeartbeat,
  readBotRuntimeHeartbeat,
  writeBotRuntimeHeartbeat,
  type BotRuntimeHeartbeat,
} from '@/server/modules/bot/bot.runtime.state';

const HEARTBEAT: BotRuntimeHeartbeat = {
  startedAt: '2026-09-25T10:00:00.000Z',
  lastCycleAt: '2026-09-25T10:01:00.000Z',
  cycleCount: 4,
  intervalSeconds: 15,
  enabledStrategies: ['gold-momentum'],
  pid: 4242,
};

beforeEach(() => {
  mocks.store.clear();
  mocks.redisFails = false;
  mocks.pttlFails = false;
});

describe('readBotRuntimeHeartbeat', () => {
  it('returns null when the key is absent', async () => {
    await expect(readBotRuntimeHeartbeat()).resolves.toBeNull();
  });

  it('round-trips a written heartbeat with its fields intact', async () => {
    const payload = await writeBotRuntimeHeartbeat(HEARTBEAT);
    expect(payload).not.toBeNull();

    const read = await readBotRuntimeHeartbeat();
    expect(read).not.toBeNull();
    expect(read).toMatchObject(HEARTBEAT);
    expect(read?.ageSeconds).toBeGreaterThanOrEqual(0);
    // A just-written heartbeat is at most a second old.
    expect(read?.ageSeconds).toBeLessThan(1);
  });

  it('reports an age derived from the remaining TTL', async () => {
    await writeBotRuntimeHeartbeat(HEARTBEAT);
    const entry = mocks.store.get(BOT_RUNTIME_HEARTBEAT_KEY);
    expect(entry).toBeDefined();
    // Pretend the key was written 10s ago: its expiry is 10s closer.
    entry!.expiresAt = Date.now() + (heartbeatTtlSeconds(HEARTBEAT.intervalSeconds) - 10) * 1000;

    const read = await readBotRuntimeHeartbeat();
    expect(read).not.toBeNull();
    expect(read?.ageSeconds).toBeGreaterThan(8);
    expect(read?.ageSeconds).toBeLessThan(12);
  });

  it('returns null, not a throw, when the stored value is malformed JSON', async () => {
    mocks.store.set(BOT_RUNTIME_HEARTBEAT_KEY, { value: '{not json', expiresAt: Date.now() + 60_000 });
    await expect(readBotRuntimeHeartbeat()).resolves.toBeNull();
  });

  it('returns null when the stored JSON is not a heartbeat', async () => {
    mocks.store.set(BOT_RUNTIME_HEARTBEAT_KEY, {
      value: JSON.stringify({ hello: 'world' }),
      expiresAt: Date.now() + 60_000,
    });
    await expect(readBotRuntimeHeartbeat()).resolves.toBeNull();
  });

  it('returns null, not a throw, when Redis is unreachable', async () => {
    await writeBotRuntimeHeartbeat(HEARTBEAT);
    mocks.redisFails = true;
    await expect(readBotRuntimeHeartbeat()).resolves.toBeNull();
  });

  it('still returns the heartbeat when only the TTL read fails', async () => {
    await writeBotRuntimeHeartbeat(HEARTBEAT);
    mocks.pttlFails = true;
    const read = await readBotRuntimeHeartbeat();
    expect(read).not.toBeNull();
    expect(read?.cycleCount).toBe(HEARTBEAT.cycleCount);
    expect(read?.ageSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('parseBotRuntimeHeartbeat', () => {
  it('rejects a JSON scalar', () => {
    expect(parseBotRuntimeHeartbeat('42')).toBeNull();
    expect(parseBotRuntimeHeartbeat('null')).toBeNull();
    expect(parseBotRuntimeHeartbeat('[]')).toBeNull();
  });

  it('coerces optional fields instead of rejecting the whole heartbeat', () => {
    const parsed = parseBotRuntimeHeartbeat(
      JSON.stringify({
        startedAt: '2026-09-25T10:00:00.000Z',
        lastCycleAt: null,
        cycleCount: 0,
        intervalSeconds: 5,
        enabledStrategies: ['gold-momentum', 7],
        pid: 1,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.lastCycleAt).toBeNull();
    expect(parsed?.enabledStrategies).toEqual(['gold-momentum']);
  });
});

describe('clearBotRuntimeHeartbeat', () => {
  it('removes the heartbeat it wrote', async () => {
    const payload = await writeBotRuntimeHeartbeat(HEARTBEAT);
    await clearBotRuntimeHeartbeat(payload);
    expect(mocks.store.has(BOT_RUNTIME_HEARTBEAT_KEY)).toBe(false);
    await expect(readBotRuntimeHeartbeat()).resolves.toBeNull();
  });

  it('does not delete a heartbeat written by another runtime', async () => {
    await writeBotRuntimeHeartbeat(HEARTBEAT);
    // A different payload (another replica's heartbeat) must survive our stop.
    await clearBotRuntimeHeartbeat(JSON.stringify({ ...HEARTBEAT, pid: 9999 }));
    expect(mocks.store.has(BOT_RUNTIME_HEARTBEAT_KEY)).toBe(true);
  });

  it('does nothing when this runtime never wrote a heartbeat', async () => {
    mocks.store.set(BOT_RUNTIME_HEARTBEAT_KEY, {
      value: JSON.stringify({ ...HEARTBEAT, pid: 9999 }),
      expiresAt: Date.now() + 60_000,
    });
    await clearBotRuntimeHeartbeat(null);
    expect(mocks.store.has(BOT_RUNTIME_HEARTBEAT_KEY)).toBe(true);
  });
});
