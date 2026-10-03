import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/http';

/**
 * BOT CONTROL — the platform gates that decide whether an order may run.
 *
 * These are the rules an operator relies on under pressure, so each is pinned
 * individually: the kill switch (both stores), the fail-closed behaviour when
 * NEITHER store answers, the symbol allow-list, the daily loss limit, and the
 * requirement that stopping trading carries a reason.
 *
 * The stores are mocked — Redis, the settings layer and the ledger — because the
 * subject under test is the DECISION logic, not ioredis or Prisma. Nothing here
 * fabricates broker data: no price, fill or P/L figure is invented in this file.
 */

const mocks = vi.hoisted(() => ({
  redisValue: null as string | null,
  redisFails: false,
  redisWrites: [] as string[][],
  dbRow: null as { value: string } | null,
  dbFails: false,
  settings: {} as Record<string, string>,
  numbers: {} as Record<string, number>,
  symbols: {} as Record<string, string[]>,
  saved: [] as Array<{ key: string; value: string | null }>,
  audited: [] as Array<{ action: string; details?: unknown }>,
  published: [] as unknown[],
  realizedToday: '0',
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    get: async () => {
      if (mocks.redisFails) throw new Error('redis down');
      return mocks.redisValue;
    },
    set: async (key: string, value: string) => {
      if (mocks.redisFails) throw new Error('redis down');
      mocks.redisWrites.push([key, value]);
      mocks.redisValue = value;
      return 'OK';
    },
  },
  rkey: (...parts: string[]) => parts.join(':'),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async () => {
        if (mocks.dbFails) throw new Error('database down');
        return mocks.dbRow;
      },
    },
  },
}));

vi.mock('@/server/modules/settings/settings.service', () => ({
  getSetting: (key: string) => mocks.settings[key] ?? '',
  getSettingNumber: (key: string) => mocks.numbers[key] ?? 0,
  getSettingSymbols: (key: string) => mocks.symbols[key] ?? [],
  saveAdminSetting: async (key: string, value: string | null) => {
    mocks.saved.push({ key, value });
    return { key, action: value === null || value === '' ? 'cleared' : 'set' };
  },
}));

vi.mock('@/server/accounting/ledger', () => ({
  getRealizedPnlToday: async () => {
    const { D } = await import('@/lib/money');
    return D(mocks.realizedToday);
  },
}));

vi.mock('@/server/modules/audit/audit.service', () => ({
  AUDIT: { RISK_KILL_SWITCH: 'RISK_KILL_SWITCH', BOT_STARTED: 'BOT_STARTED' },
  recordAudit: async (entry: { action: string; details?: unknown }) => {
    mocks.audited.push(entry);
  },
}));

vi.mock('@/server/ws/event-bus', () => ({
  publishSystemStatus: async (payload: unknown) => {
    mocks.published.push(payload);
    return 'local';
  },
}));

import {
  BOT_ENABLED_REDIS_KEY,
  checkTradingAllowed,
  getBotControlState,
  setBotEnabled,
} from '@/server/modules/bot/bot-control.service';

const ACTOR = { id: 'admin-1', email: 'ceo@autopips.pro' };

beforeEach(() => {
  mocks.redisValue = null;
  mocks.redisFails = false;
  mocks.redisWrites.length = 0;
  mocks.dbRow = null;
  mocks.dbFails = false;
  mocks.settings = {};
  mocks.numbers = {};
  mocks.symbols = {};
  mocks.saved.length = 0;
  mocks.audited.length = 0;
  mocks.published.length = 0;
  mocks.realizedToday = '0';
});

describe('kill switch state', () => {
  it('reads the live state from Redis when it is present', async () => {
    mocks.redisValue = '0';
    mocks.settings['bot.disabled_reason'] = 'broker incident';

    const state = await getBotControlState();
    expect(state.enabled).toBe(false);
    expect(state.source).toBe('redis');
    expect(state.reason).toBe('broker incident');
  });

  it('falls back to the durable row when Redis has nothing', async () => {
    mocks.dbRow = { value: 'false' };

    const state = await getBotControlState();
    expect(state.enabled).toBe(false);
    expect(state.source).toBe('database');
  });

  it('treats a platform that has never been stopped as RUNNING (no row is not unknown)', async () => {
    mocks.redisValue = null;
    mocks.dbRow = null; // fresh install: the setting was never written

    const state = await getBotControlState();
    expect(state.enabled).toBe(true);
    expect(state.source).toBe('database');
    await expect(checkTradingAllowed('frxXAUUSD')).resolves.toEqual({ allowed: true });
  });

  it('fails CLOSED when neither store can be read', async () => {
    mocks.redisFails = true;
    mocks.dbFails = true;

    const state = await getBotControlState();
    expect(state.enabled).toBe(false);
    expect(state.source).toBe('unknown');
    expect(state.reason ?? '').toMatch(/could not be read/i);
  });
});

describe('the pre-trade gate', () => {
  it('allows an order when trading is enabled and nothing is restricted', async () => {
    mocks.redisValue = '1';
    await expect(checkTradingAllowed('frxXAUUSD')).resolves.toEqual({ allowed: true });
  });

  it('refuses every order while the kill switch is engaged', async () => {
    mocks.redisValue = '0';
    mocks.settings['bot.disabled_reason'] = 'verifying fills';

    const gate = await checkTradingAllowed('frxXAUUSD');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe('BOT_KILL_SWITCH');
      expect(gate.reason).toMatch(/verifying fills/);
    }
  });

  it('refuses a symbol outside the allow-list, and allows one inside it', async () => {
    mocks.redisValue = '1';
    mocks.symbols['risk.allowed_symbols'] = ['R_100', 'frxXAUUSD'];

    const blocked = await checkTradingAllowed('cryBTCUSD');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.code).toBe('SYMBOL_NOT_ALLOWED');

    await expect(checkTradingAllowed('R_100')).resolves.toEqual({ allowed: true });
  });

  it('treats an empty allow-list as "no restriction", not "nothing allowed"', async () => {
    mocks.redisValue = '1';
    mocks.symbols['risk.allowed_symbols'] = [];
    await expect(checkTradingAllowed('anything')).resolves.toEqual({ allowed: true });
  });

  it('refuses new orders once the daily loss limit is reached', async () => {
    mocks.redisValue = '1';
    mocks.numbers['risk.daily_loss_limit_usd'] = 500;
    mocks.realizedToday = '-500.00';

    const gate = await checkTradingAllowed('frxXAUUSD');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe('DAILY_LOSS_LIMIT_REACHED');
      expect(gate.reason).toMatch(/500/);
    }
  });

  it('still allows orders while the day is inside the loss limit', async () => {
    mocks.redisValue = '1';
    mocks.numbers['risk.daily_loss_limit_usd'] = 500;
    mocks.realizedToday = '-499.99';
    await expect(checkTradingAllowed('frxXAUUSD')).resolves.toEqual({ allowed: true });
  });
});

describe('engaging and releasing the switch', () => {
  it('requires a reason to stop trading', async () => {
    await expect(
      setBotEnabled({ enabled: false, reason: '  ', actor: ACTOR }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mocks.redisWrites).toHaveLength(0);
  });

  it('writes both stores, audits the operator and notifies the console when stopping', async () => {
    await setBotEnabled({ enabled: false, reason: 'broker incident', actor: ACTOR, ip: '127.0.0.1' });

    expect(mocks.redisWrites).toEqual([[BOT_ENABLED_REDIS_KEY, '0']]);
    expect(mocks.saved).toContainEqual({ key: 'bot.enabled', value: 'false' });
    expect(mocks.saved).toContainEqual({ key: 'bot.disabled_reason', value: 'broker incident' });

    const audit = mocks.audited.find((entry) => entry.action === 'RISK_KILL_SWITCH');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.details)).toMatch(/broker incident/);

    expect(mocks.published).toHaveLength(1);
    expect((mocks.published[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it('clears the reason and audits a start when releasing', async () => {
    await setBotEnabled({ enabled: true, actor: ACTOR });

    expect(mocks.redisWrites).toEqual([[BOT_ENABLED_REDIS_KEY, '1']]);
    expect(mocks.saved).toContainEqual({ key: 'bot.disabled_reason', value: '' });
    expect(mocks.audited.some((entry) => entry.action === 'BOT_STARTED')).toBe(true);
  });

  it('does not change anything when Redis cannot be written', async () => {
    mocks.redisFails = true;
    await expect(
      setBotEnabled({ enabled: false, reason: 'test', actor: ACTOR }),
    ).rejects.toBeInstanceOf(ApiError);
    // Nothing durable was written either: the two stores must never disagree.
    expect(mocks.saved).toHaveLength(0);
    expect(mocks.audited).toHaveLength(0);
  });
});
