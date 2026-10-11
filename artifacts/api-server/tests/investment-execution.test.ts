import './helpers/test-env';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * INTERNAL EXECUTION AGAINST CLIENT INVESTMENTS — the three invariants that
 * protect client money.
 *
 *   1. The LEDGER never counts an investment-linked position: its capital/P&L is
 *      already on the Investment row, so both position aggregates (per-client and
 *      platform-wide) must filter on `investmentId: null`. Without this, deployed
 *      capital and P/L double.
 *   2. `recomputeInvestmentFromPositions` writes the documented arithmetic:
 *      realized = Σ CLOSED linked pnl, unrealized = Σ OPEN linked pnl,
 *      currentVal = capital + realized + unrealized − fees, and publishes it.
 *   3. The cycle is IDEMPOTENT: at most one OPEN linked position per
 *      (investment, symbol, strategy).
 *
 * Prisma, Redis-backed publication, the strategy engine, the market feed and the
 * settings layer are MOCKED — the subject is the wiring and the arithmetic, not
 * Postgres or a price feed. The mocks never invent a price or a P/L that the code
 * under test would then "discover".
 */

const mocks = vi.hoisted(() => ({
  positionAggregateCalls: [] as Array<{ where?: Record<string, unknown> }>,
  positionFindFirstCalls: [] as Array<{ where?: Record<string, unknown> }>,
  positionCreateCalls: [] as Array<{ data: Record<string, unknown> }>,
  investmentUpdateCalls: [] as Array<{ data: Record<string, unknown> }>,
  equityPublishes: [] as Array<{ userId: string; payload: Record<string, unknown>; includeAdmin: boolean }>,
  auditCalls: [] as Array<{ action: string }>,
  closedPnl: 0,
  openPnl: 0,
  investmentFindUnique: null as Record<string, unknown> | null,
  investments: [] as Array<Record<string, unknown>>,
  positionFindFirst: null as Record<string, unknown> | null,
  settings: {} as Record<string, string>,
  numbers: {} as Record<string, number>,
  instruments: ['frxXAUUSD'] as string[],
  candles: [] as Array<Record<string, number>>,
  signal: null as Record<string, unknown> | null,
  gate: { allowed: true, code: 'OK', reason: 'ok' } as Record<string, unknown>,
}));

vi.mock('@/lib/prisma', () => {
  const emptyAggregate = () => ({
    _sum: {
      amountUsd: 0,
      netPnL: 0,
      unrealizedPnL: 0,
      feesDeducted: 0,
      capitalUsd: 0,
      stake: 0,
      pnl: 0,
      amount: 0,
    },
    _count: { _all: 0 },
  });

  const positionAggregate = async (args: { where?: Record<string, unknown> }) => {
    mocks.positionAggregateCalls.push(args);
    // The roll-up asks by a literal status; the ledger asks with `status: { in }`.
    if (args?.where?.status === 'CLOSED') {
      return { _sum: { pnl: mocks.closedPnl }, _count: { _all: 0 } };
    }
    if (args?.where?.status === 'OPEN') {
      return { _sum: { pnl: mocks.openPnl }, _count: { _all: 0 } };
    }
    return emptyAggregate();
  };

  const prisma: Record<string, unknown> = {
    investment: {
      aggregate: async () => emptyAggregate(),
      findMany: async () => mocks.investments,
      findUnique: async () => mocks.investmentFindUnique,
      findFirst: async () => null,
      update: async (args: { data: Record<string, unknown> }) => {
        mocks.investmentUpdateCalls.push(args);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    position: {
      aggregate: positionAggregate,
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        mocks.positionFindFirstCalls.push(args);
        return mocks.positionFindFirst;
      },
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => {
        mocks.positionCreateCalls.push(args);
        return { id: 'new-position', ...args.data };
      },
      count: async () => 0,
    },
    tradeRecord: { aggregate: async () => emptyAggregate() },
    withdrawal: { aggregate: async () => emptyAggregate() },
    deposit: { aggregate: async () => emptyAggregate() },
    walletAdjustment: { aggregate: async () => emptyAggregate() },
    user: { count: async () => 0 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return { prisma };
});

vi.mock('@/server/modules/audit/audit.service', () => ({
  AUDIT: {
    POSITION_OPENED: 'POSITION_OPENED',
    POSITION_CLOSED: 'POSITION_CLOSED',
    STAKE_ALLOCATED: 'STAKE_ALLOCATED',
    RISK_KILL_SWITCH: 'RISK_KILL_SWITCH',
    INVESTMENT_PAUSED: 'INVESTMENT_PAUSED',
    INVESTMENT_ACTIVATED: 'INVESTMENT_ACTIVATED',
  },
  recordAudit: async (entry: { action: string }) => {
    mocks.auditCalls.push(entry);
  },
  recordAuditSafe: async (entry: { action: string }) => {
    mocks.auditCalls.push(entry);
  },
}));

vi.mock('@/server/ws/event-bus', () => ({
  publishEquity: async (
    userId: string,
    payload: Record<string, unknown>,
    includeAdmin: boolean,
  ) => {
    mocks.equityPublishes.push({ userId, payload, includeAdmin });
    return 'local';
  },
}));

vi.mock('@/server/modules/settings/settings.service', () => ({
  getSetting: (key: string) => mocks.settings[key] ?? '',
  getSettingNumber: (key: string) => mocks.numbers[key] ?? 0,
}));

vi.mock('@/server/modules/market/twelve-data.service', () => ({
  curatedPlatformInstruments: () => mocks.instruments,
}));

vi.mock('@/server/modules/market/public-market.service', () => ({
  getPublicCandles: async () => mocks.candles,
}));

vi.mock('@/server/modules/bot/strategy.engine', () => ({
  evaluateStrategy: async () => mocks.signal,
}));

vi.mock('@/server/modules/bot/bot-control.service', () => ({
  checkTradingAllowed: async () => mocks.gate,
}));

// investment-execution.service imports only the min-stake constant from the
// position service (which in turn imports the roll-up back — a cycle the mock
// breaks for the test).
vi.mock('@/server/modules/positions/position.service', () => ({
  POSITION_MIN_STAKE_USD: 1,
}));

import { getAccountSnapshot, getPlatformLedger } from '@/server/accounting/ledger';
import {
  recomputeInvestmentFromPositions,
  runInternalStrategyCycle,
} from '@/server/modules/positions/investment-execution.service';

const CYCLE_CONFIG = {
  timeframe: '15m',
  masterVolume: 0.1,
  fastPeriod: 12,
  slowPeriod: 26,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  candleCount: 300,
};

beforeEach(() => {
  mocks.positionAggregateCalls.length = 0;
  mocks.positionFindFirstCalls.length = 0;
  mocks.positionCreateCalls.length = 0;
  mocks.investmentUpdateCalls.length = 0;
  mocks.equityPublishes.length = 0;
  mocks.auditCalls.length = 0;
  mocks.closedPnl = 0;
  mocks.openPnl = 0;
  mocks.investmentFindUnique = null;
  mocks.investments = [];
  mocks.positionFindFirst = null;
  mocks.settings = {};
  mocks.numbers = {};
  mocks.instruments = ['frxXAUUSD'];
  mocks.candles = [{ time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
  mocks.signal = null;
  mocks.gate = { allowed: true, code: 'OK', reason: 'ok' };
});

/* ─────────────── 1. the ledger excludes investment-linked positions ─────────── */

describe('ledger treatment of investment-linked positions', () => {
  it('excludes linked positions from the OPEN aggregate in getAccountSnapshot (stake/pnl already carried by the Investment)', async () => {
    await getAccountSnapshot('user-1');

    // OPEN and CLOSED each get their own aggregate.
    expect(mocks.positionAggregateCalls).toHaveLength(2);
    const open = mocks.positionAggregateCalls.find((call) =>
      JSON.stringify(call.where?.status).includes('OPEN'),
    );
    const closed = mocks.positionAggregateCalls.find((call) =>
      JSON.stringify(call.where?.status).includes('CLOSED'),
    );
    expect(open?.where?.investmentId).toBeNull();
    // CLOSED pnl is realized for BOTH books: the ledger's realized term reads
    // position pnl directly, so filtering it out would make equity FALL when a
    // winning linked position closed (its pnl leaves unrealized and never arrives).
    expect(closed).toBeDefined();
    expect(closed?.where?.investmentId).toBeUndefined();
  });

  it('excludes linked positions from the OPEN aggregate in getPlatformLedger, and keeps them in CLOSED', async () => {
    await getPlatformLedger();

    expect(mocks.positionAggregateCalls).toHaveLength(2);
    const open = mocks.positionAggregateCalls.find((call) =>
      JSON.stringify(call.where?.status).includes('OPEN'),
    );
    const closed = mocks.positionAggregateCalls.find((call) =>
      JSON.stringify(call.where?.status).includes('CLOSED'),
    );
    expect(open?.where?.investmentId).toBeNull();
    expect(closed?.where?.investmentId).toBeUndefined();
  });
});

/* ──────────────── 2. recomputeInvestmentFromPositions arithmetic ─────────────── */

describe('recomputeInvestmentFromPositions', () => {
  it('sets realized/unrealized/currentVal from the linked positions and publishes equity', async () => {
    mocks.investmentFindUnique = {
      id: 'inv-1',
      userId: 'user-1',
      capitalUsd: 1000,
      feesDeducted: 25,
    };
    mocks.closedPnl = 50;
    mocks.openPnl = -10;

    const rollup = await recomputeInvestmentFromPositions('inv-1');

    // 1000 + 50 + (−10) − 25 = 1015
    expect(rollup).not.toBeNull();
    expect(rollup!.realizedPnL).toBe(50);
    expect(rollup!.unrealizedPnL).toBe(-10);
    expect(rollup!.currentValUsd).toBe(1015);

    expect(mocks.investmentUpdateCalls).toHaveLength(1);
    const data = mocks.investmentUpdateCalls[0]!.data;
    expect((data.realizedPnL as { toNumber(): number }).toNumber()).toBe(50);
    expect((data.unrealizedPnL as { toNumber(): number }).toNumber()).toBe(-10);
    expect((data.currentValUsd as { toNumber(): number }).toNumber()).toBe(1015);

    expect(mocks.equityPublishes).toHaveLength(1);
    const published = mocks.equityPublishes[0]!;
    expect(published.userId).toBe('user-1');
    expect(published.includeAdmin).toBe(true);
    expect(published.payload.scope).toBe('investment');
    expect(published.payload.investmentId).toBe('inv-1');
    expect(published.payload.capitalUsd).toBe(1000);
    expect(published.payload.realizedPnL).toBe(50);
    expect(published.payload.unrealizedPnL).toBe(-10);
    expect(published.payload.feesDeducted).toBe(25);
    expect(published.payload.currentValUsd).toBe(1015);
  });

  it('returns null and publishes nothing for a missing investment', async () => {
    mocks.investmentFindUnique = null;

    const rollup = await recomputeInvestmentFromPositions('missing');

    expect(rollup).toBeNull();
    expect(mocks.investmentUpdateCalls).toHaveLength(0);
    expect(mocks.equityPublishes).toHaveLength(0);
  });
});

/* ───────────────────────── 3. cycle idempotency ──────────────────────────────── */

describe('runInternalStrategyCycle idempotency', () => {
  function primeOneActiveInvestment(): void {
    mocks.investments = [
      {
        id: 'inv-1',
        userId: 'user-1',
        capitalUsd: 1000,
        currentValUsd: 1000,
        plan: { maxDrawdown: 20 },
      },
    ];
    mocks.signal = {
      signalId: 'sig-1',
      symbol: 'frxXAUUSD',
      direction: 'BUY',
      masterVolume: 0.1,
      stopLoss: 95,
      takeProfit: 110,
      reason: 'test signal',
      strategy: 'gold-momentum',
      brokerAccountId: '',
      createdAt: new Date(1),
    };
    mocks.numbers['risk.risk_per_trade_pct'] = 1;
    mocks.numbers['risk.max_stake_usd'] = 100;
    mocks.settings['risk.allowed_symbols'] = '';
  }

  it('skips an investment that already has an OPEN linked position for the setup', async () => {
    primeOneActiveInvestment();
    mocks.positionFindFirst = { id: 'already-open' };

    const result = await runInternalStrategyCycle('gold-momentum', CYCLE_CONFIG);

    expect(result.signals).toBe(1);
    expect(result.opened).toBe(0);
    expect(mocks.positionCreateCalls).toHaveLength(0);
    expect(result.entries.some((entry) => entry.reason === 'ALREADY_OPEN')).toBe(true);

    // The idempotency key is exactly (investment, symbol, strategyId, OPEN).
    expect(mocks.positionFindFirstCalls[0]!.where).toEqual({
      investmentId: 'inv-1',
      symbol: 'frxXAUUSD',
      strategyId: 'gold-momentum',
      status: 'OPEN',
    });
  });

  it('opens exactly one linked position when no OPEN position exists for the setup', async () => {
    primeOneActiveInvestment();
    mocks.positionFindFirst = null;
    mocks.investmentFindUnique = { userId: 'user-1', capitalUsd: 1000, status: 'ACTIVE' };

    const result = await runInternalStrategyCycle('gold-momentum', CYCLE_CONFIG);

    expect(result.opened).toBe(1);
    expect(mocks.positionCreateCalls).toHaveLength(1);
    const data = mocks.positionCreateCalls[0]!.data;
    expect(data.investmentId).toBe('inv-1');
    expect(data.strategyId).toBe('gold-momentum');
    expect(data.symbol).toBe('frxXAUUSD');
    expect(data.side).toBe('BUY');
    expect(data.status).toBe('OPEN');
    expect(data.executionMode).toBe('INTERNAL');
    // Stake sized to 1% of 1000 = 10, inside [1, capital].
    expect((data.stake as { toNumber(): number }).toNumber()).toBe(10);
  });
});
