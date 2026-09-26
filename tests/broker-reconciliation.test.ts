import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerConnection } from '@prisma/client';

import { D } from '@/lib/money';
import type { BrokerPosition, PositionClosure } from '@/server/modules/broker/broker.types';
import * as sync from '@/server/modules/broker/broker.sync';
import * as reconcile from '@/server/modules/broker/broker.reconcile';

/**
 * BROKER -> LEDGER RECONCILIATION — the money-path ratchets.
 *
 * Four defects are pinned here, all of them "the ledger silently disagrees with
 * the broker":
 *
 *   1. ATTRIBUTION. A Deriv contract carried no comment and no investment id, so
 *      every position was dropped as unattributed and never rolled up. The fix
 *      resolves through the contract-id map written at FILL time first, then the
 *      legacy comment tag, and refuses to guess.
 *   2. SIZE. Deriv reports a STAKE, not lots, and the booking path refused
 *      anything without a lot size. A stake is a broker-reported figure (the
 *      contract's buy price) and it is what the schema says `TradeRecord.volume`
 *      carries for a stake-denominated broker.
 *   3. CLOSURE. A Deriv closure has no closing volume by construction, so the
 *      lot-coverage rule refused every settlement and no realized P/L was ever
 *      written. `fullyClosed` (the broker's own settlement proof) is the gate for
 *      a contract broker; the volume rule still governs a lot broker.
 *   4. ATOMICITY. Two closers (sync + manual) must not both book the same
 *      position. The compare-and-swap is the `status: 'OPEN'` predicate on the
 *      update, so exactly one writer can win.
 *
 * All broker/DB I/O is mocked: the assertions are about the DECISIONS this code
 * makes from broker-reported numbers, which is the part that was wrong.
 */

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

const mocks = vi.hoisted(() => {
  const fns = {
    tradeFindUnique: vi.fn(),
    tradeFindMany: vi.fn(),
    tradeCreate: vi.fn(),
    tradeUpdate: vi.fn(),
    tradeUpdateMany: vi.fn(),
    tradeAggregate: vi.fn(),
    tradeCount: vi.fn(),
    investmentFindMany: vi.fn(),
    investmentFindUnique: vi.fn(),
    investmentUpdate: vi.fn(),
    auditCreate: vi.fn(),
    platformLedger: vi.fn(),
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    publishActivity: vi.fn(),
    publishEquity: vi.fn(),
    updateBrokerSnapshot: vi.fn(),
    getDealsSince: vi.fn(),
  };

  // One object doubles as the client and as the transaction client handed to
  // `prisma.$transaction`, because `recomputeInvestment` runs in a transaction
  // and the roll-up is not the subject of these assertions.
  const prismaMock: Record<string, unknown> = {
    tradeRecord: {
      findUnique: fns.tradeFindUnique,
      findMany: fns.tradeFindMany,
      create: fns.tradeCreate,
      update: fns.tradeUpdate,
      updateMany: fns.tradeUpdateMany,
      aggregate: fns.tradeAggregate,
      count: fns.tradeCount,
    },
    investment: {
      findMany: fns.investmentFindMany,
      findUnique: fns.investmentFindUnique,
      update: fns.investmentUpdate,
    },
    auditLog: { create: fns.auditCreate },
  };
  prismaMock.$transaction = async (cb: (tx: unknown) => unknown) => cb(prismaMock);

  return { ...fns, prismaMock, positions: [] as unknown[], positionClosure: null as unknown };
});

vi.mock('@/lib/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mocks.redisGet(...args),
    set: (...args: unknown[]) => mocks.redisSet(...args),
    incr: vi.fn(),
    del: vi.fn(),
  },
  rkey: (...parts: Array<string | number>) => ['autopips', ...parts].join(':'),
}));

vi.mock('@/server/ws/event-bus', () => ({
  publishActivity: (...args: unknown[]) => mocks.publishActivity(...args),
  publishEquity: (...args: unknown[]) => mocks.publishEquity(...args),
}));

vi.mock('@/server/modules/broker/broker.registry', () => ({
  makeActivity: (
    action: string,
    message: string,
    severity: string,
    details: Record<string, unknown> = {},
    rooms: string[] = ['admin'],
  ) => ({
    id: 'act-1',
    action,
    message,
    severity,
    details,
    rooms,
    createdAt: '2026-01-01T00:00:00.000Z',
  }),
  investmentRooms: (investmentId: string | null) => (investmentId ? ['inv', 'admin'] : ['admin']),
  updateBrokerSnapshot: (...args: unknown[]) => mocks.updateBrokerSnapshot(...args),
  ensureBrokerConnected: async (adapter: unknown) => adapter,
  getAdapterForConnection: async () => ({
    accountId: 'acct-1',
    sizeDenomination: 'stake',
    isConnected: () => true,
    getAccountState: async () => ({
      accountId: 'acct-1',
      brokerName: 'Deriv',
      environment: 'DEMO',
      maskedAccount: '***-0001',
      currency: 'USD',
      balance: 1000,
      equity: 1000,
      freeMargin: null,
      margin: null,
      leverage: null,
      isTradingEnabled: true,
      status: 'CONNECTED',
      rawState: 'AUTHORIZED',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    getOpenPositions: async () => mocks.positions,
    getDealsSince: (...args: unknown[]) => mocks.getDealsSince(...args),
    getPositionClosure: async () => mocks.positionClosure,
  }),
}));

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prismaMock }));

vi.mock('@/server/accounting/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/accounting/ledger')>();
  return {
    ...actual,
    getPlatformLedger: (...args: unknown[]) => mocks.platformLedger(...args),
  };
});

function position(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    positionId: '5001',
    instrument: 'frxXAUUSD',
    direction: 'BUY',
    volume: null,
    stakeUsd: 100,
    multiplier: 100,
    entryPrice: 4270,
    currentPrice: 4271,
    stopLoss: null,
    takeProfit: null,
    unrealizedPnL: 5,
    commission: null,
    swap: null,
    comment: null,
    openedAt: new Date('2026-01-01T00:00:00.000Z'),
    investmentId: null,
    ...overrides,
  };
}

function closure(overrides: Partial<PositionClosure> = {}): PositionClosure {
  return {
    positionId: '5001',
    exitPrice: 4275,
    closingVolume: null,
    fullyClosed: true,
    grossPnL: null,
    commission: null,
    swap: null,
    netPnL: 12.34,
    closedAt: new Date('2026-01-02T03:04:05.000Z'),
    dealIds: [],
    ...overrides,
  };
}

function connection(overrides: Partial<BrokerConnection> = {}): BrokerConnection {
  return {
    id: 'conn-1',
    derivAccountId: 'acct-1',
    brokerName: 'Deriv',
    environment: 'DEMO',
    maskedAccount: '***-0001',
    balance: null,
    equity: null,
    freeMargin: null,
    status: 'CONNECTED',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as BrokerConnection;
}

/** Ledger totals holding `deployed` on-broker and `idle` off-broker. */
function platformLedger(deployed: string, idle: string): Record<string, unknown> {
  return {
    totalManagedCapital: D(deployed),
    totalEquity: D(deployed).plus(idle),
    realizedPnL: D('0'),
    unrealizedPnL: D('0'),
    deductedFees: D('0'),
    withdrawalsPaid: D('0'),
    confirmedDeposits: D(deployed).plus(idle),
    activeClients: 1,
    openInvestments: 1,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset();
  }
  mocks.positions = [];
  mocks.positionClosure = null;
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSet.mockResolvedValue('OK');
  mocks.getDealsSince.mockResolvedValue([]);
  mocks.tradeFindUnique.mockResolvedValue(null);
  mocks.tradeFindMany.mockResolvedValue([]);
  mocks.tradeCreate.mockResolvedValue({});
  mocks.tradeUpdate.mockResolvedValue({});
  mocks.tradeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.tradeCount.mockResolvedValue(0);
  mocks.auditCreate.mockResolvedValue({});
  mocks.investmentFindMany.mockResolvedValue([]);
  mocks.investmentFindUnique.mockResolvedValue(null);
});

/* ------------------------------------------------------------------ 1. attribution */

describe('attribution resolution order', () => {
  it('prefers the contract-id map written at fill time, even when a comment tag disagrees', async () => {
    mocks.tradeFindUnique.mockResolvedValue({ investmentId: 'inv-booked' });

    const result = await sync.resolvePositionInvestment(
      'conn-1',
      position({ comment: `sig:abc:inv:${UUID_B}`, investmentId: UUID_B }),
    );

    expect(result).toEqual({ investmentId: 'inv-booked', source: 'trade-record' });
  });

  it('falls back to the investment id the broker position carries', async () => {
    mocks.tradeFindUnique.mockResolvedValue(null);

    const result = await sync.resolvePositionInvestment('conn-1', position({ investmentId: UUID_A }));

    expect(result).toEqual({ investmentId: UUID_A, source: 'position' });
  });

  it('falls back to the inv:<uuid> comment tag for a lot-denominated bridge', async () => {
    mocks.tradeFindUnique.mockResolvedValue(null);

    const result = await sync.resolvePositionInvestment(
      'conn-1',
      position({ comment: `sig:abc:inv:${UUID_A}` }),
    );

    expect(result).toEqual({ investmentId: UUID_A, source: 'comment' });
  });

  it('leaves a position with no record and no tag UNATTRIBUTED rather than guessing', async () => {
    mocks.tradeFindUnique.mockResolvedValue(null);

    const result = await sync.resolvePositionInvestment(
      'conn-1',
      position({ comment: 'sig:abc', investmentId: null }),
    );

    expect(result).toEqual({ investmentId: null, source: null });
  });
});

/* ------------------------------------------------------------------------ 2. size */

describe('stake vs lot size mapping', () => {
  it('books a lot position as lots and leaves notional to the volume x price fallback', () => {
    const size = sync.resolvePositionSize(
      position({ volume: 0.1, stakeUsd: null, multiplier: null }),
    );

    expect(size).not.toBeNull();
    expect(D(size?.volume).toString()).toBe('0.1');
    expect(size?.notional).toBeNull();
  });

  it('books a Deriv stake position with volume = stake and notional = stake x multiplier', () => {
    const size = sync.resolvePositionSize(
      position({ volume: null, stakeUsd: 100, multiplier: 100 }),
    );

    expect(size).not.toBeNull();
    expect(D(size?.volume).toString()).toBe('100');
    // 100 x 100, NOT volume x entryPrice (which would read 427,000 for gold at 4270).
    expect(D(size?.notional).toString()).toBe('10000');
  });

  it('refuses a position that reports neither a lot size nor a stake', () => {
    expect(sync.resolvePositionSize(position({ volume: null, stakeUsd: null }))).toBeNull();
  });
});

/* --------------------------------------------------------------------- 3. closure */

describe('closure acceptance rule', () => {
  const openTrade = { id: 't1', investmentId: 'inv-1', status: 'OPEN', volume: '0.1' };

  it('accepts a contract closure the broker proved settled, with no closing volume at all', async () => {
    mocks.tradeFindUnique.mockResolvedValue(openTrade);

    const applied = await sync.applyPositionClosure(
      'conn-1',
      closure({ fullyClosed: true, closingVolume: null }),
    );

    expect(applied).toEqual({ investmentId: 'inv-1', tradeId: 't1', netPnL: 12.34 });
    expect(mocks.tradeUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('still REFUSES a lot-broker closure whose closing volume is unreported', async () => {
    mocks.tradeFindUnique.mockResolvedValue(openTrade);

    const applied = await sync.applyPositionClosure(
      'conn-1',
      closure({ fullyClosed: false, closingVolume: null }),
    );

    expect(applied).toBeNull();
    expect(mocks.tradeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still REFUSES a lot-broker PARTIAL close, even though it reported a volume', async () => {
    mocks.tradeFindUnique.mockResolvedValue(openTrade);

    const applied = await sync.applyPositionClosure(
      'conn-1',
      closure({ fullyClosed: false, closingVolume: 0.05 }),
    );

    expect(applied).toBeNull();
    expect(mocks.tradeUpdateMany).not.toHaveBeenCalled();
  });

  it('accepts a lot-broker closure whose closing deals cover the whole booked volume', async () => {
    mocks.tradeFindUnique.mockResolvedValue(openTrade);

    const applied = await sync.applyPositionClosure(
      'conn-1',
      closure({ fullyClosed: false, closingVolume: 0.1 }),
    );

    expect(applied).not.toBeNull();
    expect(mocks.tradeUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('is atomic: a second closer loses the compare-and-swap and writes no audit row', async () => {
    mocks.tradeFindUnique.mockResolvedValue(openTrade);
    mocks.tradeUpdateMany.mockResolvedValue({ count: 0 }); // the other writer won

    const applied = await sync.applyPositionClosure('conn-1', closure());

    expect(applied).toBeNull();
    const args = mocks.tradeUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    // The status predicate IS the compare-and-swap.
    expect(args.where).toEqual({ id: 't1', status: 'OPEN' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------- booking through the sync cycle */

describe('sync cycle booking', () => {
  it('writes volume = stake and notional on the UPDATE path for a Deriv position', async () => {
    mocks.positions = [position({ positionId: '5001', volume: null, stakeUsd: 100, multiplier: 100 })];
    // resolvePositionInvestment reads with `select`; the upsert reads the full row.
    mocks.tradeFindUnique.mockImplementation(async (args: unknown) =>
      (args as { select?: unknown }).select
        ? { investmentId: 'inv-1' }
        : { id: 't1', investmentId: 'inv-1', status: 'OPEN' },
    );
    mocks.investmentFindMany.mockResolvedValue([{ id: 'inv-1' }]);

    const summary = await sync.syncBrokerConnection(connection());

    expect(summary.unattributed).toBe(0);
    expect(mocks.tradeUpdate).toHaveBeenCalledTimes(1);
    const data = (mocks.tradeUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(D(data.volume as string).toString()).toBe('100');
    expect(D(data.notional as string).toString()).toBe('10000');
  });

  it('creates the row for a position first seen by the sync (never booked at fill time)', async () => {
    mocks.positions = [position({ positionId: '5002' })];
    mocks.tradeFindUnique.mockImplementation(async (args: unknown) =>
      (args as { select?: unknown }).select ? { investmentId: 'inv-1' } : null,
    );
    mocks.investmentFindMany.mockResolvedValue([{ id: 'inv-1' }]);

    await sync.syncBrokerConnection(connection());

    expect(mocks.tradeCreate).toHaveBeenCalledTimes(1);
    const data = (mocks.tradeCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(D(data.volume as string).toString()).toBe('100');
    expect(D(data.notional as string).toString()).toBe('10000');
  });

  it('reports an unattributed position instead of booking it', async () => {
    mocks.positions = [position({ positionId: '9001', comment: 'sig:abc', investmentId: null })];
    mocks.tradeFindUnique.mockResolvedValue(null);

    const summary = await sync.syncBrokerConnection(connection());

    expect(summary.unattributed).toBe(1);
    expect(summary.unattributedContractIds).toEqual(['9001']);
    expect(mocks.tradeCreate).not.toHaveBeenCalled();
    expect(mocks.tradeUpdate).not.toHaveBeenCalled();
  });

  it('queries deals over a bounded overlap BEFORE the watermark, not from it', async () => {
    const watermark = new Date('2026-01-01T12:00:00.000Z');
    mocks.redisGet.mockResolvedValue(watermark.toISOString());

    await sync.syncBrokerConnection(connection());

    const since = mocks.getDealsSince.mock.calls[0]?.[0] as Date;
    // 6h of overlap: a contract that settled after its purchase time cannot fall
    // outside the next window and go unbooked forever.
    expect(watermark.getTime() - since.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it('books a settlement through the close path when the broker no longer lists the contract', async () => {
    // No open positions, but an OPEN ledger row: the contract settled (or the
    // settlement was missed) — this is the path that used to be blocked by the
    // missing closing volume, leaving realized P/L unwritten forever.
    mocks.positions = [];
    mocks.redisGet.mockResolvedValue('2026-01-01T12:00:00.000Z');
    mocks.tradeFindMany.mockResolvedValue([
      { id: 't1', investmentId: 'inv-1', derivContractId: '5001' },
    ]);
    mocks.tradeFindUnique.mockResolvedValue({
      id: 't1',
      investmentId: 'inv-1',
      status: 'OPEN',
      volume: '100',
    });
    mocks.positionClosure = closure({ positionId: '5001', fullyClosed: true, closingVolume: null });

    const summary = await sync.syncBrokerConnection(
      connection({ id: 'conn-close', derivAccountId: 'acct-close' }),
    );

    expect(summary.errors).toBe(0);
    expect(mocks.tradeUpdateMany).toHaveBeenCalledTimes(1);
    const data = (mocks.tradeUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('CLOSED');
    expect(D(data.netPnL as string).toString()).toBe('12.34');
  });
});

/* ------------------------------------------------------------------ reconciliation */

describe('reconciliation report', () => {
  it('compares the broker against DEPLOYED ledger equity, not idle-cash-inclusive equity', async () => {
    // The ledger holds 1,000 deployed and 9,000 idle (deposited, not deployed).
    // `getPlatformLedger().totalEquity` reads 10,000, but the broker only ever
    // holds the deployed 1,000 — comparing against 10,000 would report a permanent
    // 9,000 drift, which is the false positive this figure exists to avoid.
    mocks.platformLedger.mockResolvedValue(platformLedger('1000', '9000'));

    expect(await reconcile.ledgerDeployedEquity()).toBe(1000);
  });

  it('flags drift beyond threshold and alerts once', async () => {
    mocks.positions = [position({ positionId: '5003', unrealizedPnL: 0 })];
    mocks.tradeFindUnique.mockResolvedValue({ investmentId: 'inv-1' });
    mocks.investmentFindMany.mockResolvedValue([{ id: 'inv-1' }]);
    mocks.tradeCount.mockResolvedValue(3);
    mocks.platformLedger.mockResolvedValue(platformLedger('1000', '0'));
    // Broker equity is null: an unreported figure, so equity cannot be judged...
    const report = await reconcile.reconcileBrokerConnection(
      connection({ id: 'conn-drift', derivAccountId: 'acct-drift', equity: null }),
    );

    expect(report.brokerEquity).toBeNull();
    expect(report.equityDrift).toBeNull();
    // ...but the position-count mismatch (1 broker vs 3 booked) still breaches,
    // because 0 positions IS a real broker-reported count, not a missing one.
    expect(report.positionDrift).toBe(-2);
    expect(report.driftDetected).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.publishActivity).toHaveBeenCalledTimes(1);
  });

  it('throttles the alert so a persistent drift cannot write a row per poll', async () => {
    mocks.positions = [position({ positionId: '5005', unrealizedPnL: 0 })];
    mocks.tradeFindUnique.mockResolvedValue({ investmentId: 'inv-1' });
    mocks.investmentFindMany.mockResolvedValue([{ id: 'inv-1' }]);
    mocks.tradeCount.mockResolvedValue(4);
    mocks.platformLedger.mockResolvedValue(platformLedger('1000', '0'));
    const conn = connection({ id: 'conn-throttle', derivAccountId: 'acct-throttle', equity: null });

    await reconcile.reconcileBrokerConnection(conn);
    await reconcile.reconcileBrokerConnection(conn);
    await reconcile.reconcileBrokerConnection(conn);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.publishActivity).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the broker agrees with the ledger', async () => {
    mocks.positions = [position({ positionId: '5004' })];
    mocks.tradeFindUnique.mockResolvedValue({ investmentId: 'inv-1' });
    mocks.investmentFindMany.mockResolvedValue([{ id: 'inv-1' }]);
    mocks.tradeCount.mockResolvedValue(1);
    mocks.platformLedger.mockResolvedValue(platformLedger('1000', '0'));

    const report = await reconcile.reconcileBrokerConnection(
      connection({ id: 'conn-clean', derivAccountId: 'acct-clean', equity: D('1000') }),
    );

    expect(report.equityDrift).toBe(0);
    expect(report.positionDrift).toBe(0);
    expect(report.driftDetected).toBe(false);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.publishActivity).not.toHaveBeenCalled();
  });
});
