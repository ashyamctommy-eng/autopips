import { describe, it, expect } from 'vitest';
import type { BrokerAccountState } from '@/server/modules/broker/broker.types';
import {
  computeDrawdownPct,
  evaluatePreTradeRisk,
  type RiskContextWithFloor,
} from '@/server/modules/bot/risk.engine';
import type { RiskRejectionReason } from '@/server/modules/bot/bot.types';

/**
 * PRE-TRADE RISK GATE SUITE.
 *
 * Nine rules, evaluated in a documented order, fail-closed. The two properties
 * this suite hammers:
 *   1. An unevaluable input REJECTS (never "assume it fits") — an unknown symbol
 *      spec, a zero/NaN/Infinity equity, a disconnected broker.
 *   2. When several rules fail, the report names the FIRST one in documented
 *      order, and the checks array still carries the full picture.
 */

const DOCUMENTED_ORDER: RiskRejectionReason[] = [
  'ACCOUNT_NOT_ACTIVE',
  'BROKER_DISCONNECTED',
  'DUPLICATE_SIGNAL',
  'MASTER_EQUITY_FLOOR_BREACHED',
  'DRAWDOWN_BREACHED',
  'MAX_OPEN_POSITIONS_REACHED',
  'LOT_TOO_LARGE',
  'SYMBOL_NOT_TRADABLE',
  'INSUFFICIENT_FREE_MARGIN',
];

function account(overrides: Partial<BrokerAccountState> = {}): BrokerAccountState {
  return {
    accountId: 'acct-1',
    brokerName: 'Exness',
    environment: 'LIVE',
    maskedAccount: '***-9012',
    currency: 'USD',
    balance: 10000,
    equity: 10000,
    freeMargin: 9000,
    margin: 1000,
    leverage: 100,
    isTradingEnabled: true,
    status: 'CONNECTED',
    rawState: 'DEPLOYED',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function context(overrides: Partial<RiskContextWithFloor> = {}): RiskContextWithFloor {
  return {
    account: account(),
    maxDrawdownPct: 20,
    peakEquity: 11000,
    capitalUsd: 10000,
    currentEquity: 10000,
    openPositions: 3,
    maxOpenPositions: 50,
    signalVolume: 1,
    maxLotPerOrder: 10,
    minClientCapitalUsd: 100,
    duplicate: false,
    freeMargin: 9000,
    requiredMargin: 1500,
    symbolTradable: true,
    masterEquityFloorUsd: 0,
    ...overrides,
  };
}

/** Every check before `index` must have passed (attribution, not just rejection). */
function expectFirstFailure(ctx: RiskContextWithFloor, reason: RiskRejectionReason, name: string): void {
  const decision = evaluatePreTradeRisk(ctx);
  expect(decision.passed).toBe(false);
  expect(decision.rejectionReason).toBe(reason);

  const index = decision.checks.findIndex((entry) => entry.name === name);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(decision.checks[index]?.passed).toBe(false);
  for (const earlier of decision.checks.slice(0, index)) {
    expect(earlier.passed, `expected "${earlier.name}" (before ${name}) to pass`).toBe(true);
  }
}

describe('evaluatePreTradeRisk: a fully valid context passes all nine rules', () => {
  it('passes with nine checks, no rejection reason, and no permissive default', () => {
    const decision = evaluatePreTradeRisk(context());
    expect(decision.passed).toBe(true);
    expect(decision.rejectionReason).toBeUndefined();
    expect(decision.checks).toHaveLength(9);
    expect(decision.checks.map((entry) => entry.name)).toEqual([
      'ACCOUNT_NOT_ACTIVE',
      'BROKER_DISCONNECTED',
      'DUPLICATE_SIGNAL',
      'MASTER_EQUITY_FLOOR_BREACHED',
      'DRAWDOWN_BREACHED',
      'MAX_OPEN_POSITIONS_REACHED',
      'LOT_TOO_LARGE',
      'SYMBOL_NOT_TRADABLE',
      'INSUFFICIENT_FREE_MARGIN',
    ]);
    for (const entry of decision.checks) {
      expect(entry.passed, `${entry.name}: ${entry.detail}`).toBe(true);
      expect(entry.reason).toBeDefined();
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports one rejection reason per check so the activity feed can attribute it', () => {
    const decision = evaluatePreTradeRisk(context());
    expect(decision.checks.map((entry) => entry.reason)).toEqual(DOCUMENTED_ORDER);
  });
});

describe('evaluatePreTradeRisk: one test per rule', () => {
  it('rule 1 ACCOUNT_NOT_ACTIVE: trading disabled', () => {
    expectFirstFailure(
      context({ account: account({ isTradingEnabled: false }) }),
      'ACCOUNT_NOT_ACTIVE',
      'ACCOUNT_NOT_ACTIVE',
    );
  });

  it('rule 1 ACCOUNT_NOT_ACTIVE: terminal broker error state', () => {
    for (const rawState of ['DEPLOY_FAILED', 'UNDEPLOY_FAILED', 'DELETE_FAILED', 'REDEPLOY_FAILED']) {
      expectFirstFailure(
        context({ account: account({ rawState }) }),
        'ACCOUNT_NOT_ACTIVE',
        'ACCOUNT_NOT_ACTIVE',
      );
    }
  });

  it('rule 2 BROKER_DISCONNECTED: status DISCONNECTED or ERROR', () => {
    for (const status of ['DISCONNECTED', 'ERROR'] as const) {
      expectFirstFailure(
        context({ account: account({ status }) }),
        'BROKER_DISCONNECTED',
        'BROKER_DISCONNECTED',
      );
    }
  });

  it('rule 3 DUPLICATE_SIGNAL: an already-processed signalId is refused', () => {
    expectFirstFailure(context({ duplicate: true }), 'DUPLICATE_SIGNAL', 'DUPLICATE_SIGNAL');
  });

  it('rule 4 MASTER_EQUITY_FLOOR_BREACHED: equity at or below the floor', () => {
    expectFirstFailure(
      context({ account: account({ equity: 0 }) }),
      'MASTER_EQUITY_FLOOR_BREACHED',
      'MASTER_EQUITY_FLOOR_BREACHED',
    );
    expectFirstFailure(
      context({ account: account({ equity: 100 }), masterEquityFloorUsd: 100 }),
      'MASTER_EQUITY_FLOOR_BREACHED',
      'MASTER_EQUITY_FLOOR_BREACHED',
    );
    expectFirstFailure(
      context({ account: account({ equity: 5000 }), masterEquityFloorUsd: 6000 }),
      'MASTER_EQUITY_FLOOR_BREACHED',
      'MASTER_EQUITY_FLOOR_BREACHED',
    );
  });

  it('rule 5 DRAWDOWN_BREACHED: current drawdown at or beyond the limit', () => {
    expectFirstFailure(context({ currentEquity: 7000 }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
    // exactly at the limit (20%) is a breach: the rule is `drawdown < limit`
    expectFirstFailure(context({ currentEquity: 9000 }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
  });

  it('rule 6 MAX_OPEN_POSITIONS_REACHED: open positions at the cap', () => {
    expectFirstFailure(context({ openPositions: 50 }), 'MAX_OPEN_POSITIONS_REACHED', 'MAX_OPEN_POSITIONS_REACHED');
    expectFirstFailure(context({ openPositions: 51 }), 'MAX_OPEN_POSITIONS_REACHED', 'MAX_OPEN_POSITIONS_REACHED');
  });

  it('rule 7 LOT_TOO_LARGE: signal volume above the per-order cap', () => {
    expectFirstFailure(context({ signalVolume: 10.01 }), 'LOT_TOO_LARGE', 'LOT_TOO_LARGE');
  });

  it('rule 8 SYMBOL_NOT_TRADABLE: broker spec does not allow trading', () => {
    expectFirstFailure(context({ symbolTradable: false }), 'SYMBOL_NOT_TRADABLE', 'SYMBOL_NOT_TRADABLE');
  });

  it('rule 9 INSUFFICIENT_FREE_MARGIN: required margin exceeds free margin', () => {
    expectFirstFailure(
      context({ requiredMargin: 9500, freeMargin: 9000 }),
      'INSUFFICIENT_FREE_MARGIN',
      'INSUFFICIENT_FREE_MARGIN',
    );
  });
});

describe('evaluatePreTradeRisk: fail-closed proofs', () => {
  it('unknown symbol spec (requiredMargin null) → REJECTED, not passed', () => {
    expectFirstFailure(context({ requiredMargin: null }), 'INSUFFICIENT_FREE_MARGIN', 'INSUFFICIENT_FREE_MARGIN');
    const decision = evaluatePreTradeRisk(context({ requiredMargin: null }));
    expect(decision.passed).toBe(false);
  });

  it('capitalUsd 0 → DRAWDOWN_BREACHED (not a silent 0% drawdown)', () => {
    expectFirstFailure(context({ capitalUsd: 0 }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
    // ...and the check detail says it could not be evaluated.
    const decision = evaluatePreTradeRisk(context({ capitalUsd: 0 }));
    const drawdown = decision.checks.find((entry) => entry.name === 'DRAWDOWN_BREACHED');
    expect(drawdown?.detail).toMatch(/cannot be evaluated/i);
  });

  it('missing / NaN / Infinity equity → rejected', () => {
    for (const equity of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const decision = evaluatePreTradeRisk(context({ account: account({ equity }) }));
      expect(decision.passed).toBe(false);
      expect(decision.rejectionReason).toBe('MASTER_EQUITY_FLOOR_BREACHED');
    }
    // A structurally absent equity (undefined smuggled through a cast) also rejects.
    const missing = { ...account(), equity: undefined } as unknown as BrokerAccountState;
    const decision = evaluatePreTradeRisk(context({ account: missing }));
    expect(decision.passed).toBe(false);
    expect(decision.rejectionReason).toBe('MASTER_EQUITY_FLOOR_BREACHED');
  });

  it('NaN/Infinity peak, current equity or non-finite inputs → rejected', () => {
    expectFirstFailure(context({ peakEquity: Number.NaN }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
    expectFirstFailure(context({ currentEquity: Number.NaN }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
    expectFirstFailure(context({ maxDrawdownPct: 0 }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
    expectFirstFailure(context({ maxDrawdownPct: Number.NaN }), 'DRAWDOWN_BREACHED', 'DRAWDOWN_BREACHED');
  });

  it('non-finite position counts and lot sizes → rejected', () => {
    expectFirstFailure(context({ maxOpenPositions: Number.NaN }), 'MAX_OPEN_POSITIONS_REACHED', 'MAX_OPEN_POSITIONS_REACHED');
    expectFirstFailure(context({ openPositions: Number.NaN }), 'MAX_OPEN_POSITIONS_REACHED', 'MAX_OPEN_POSITIONS_REACHED');
    expectFirstFailure(context({ signalVolume: 0 }), 'LOT_TOO_LARGE', 'LOT_TOO_LARGE');
    expectFirstFailure(context({ signalVolume: Number.NaN }), 'LOT_TOO_LARGE', 'LOT_TOO_LARGE');
    expectFirstFailure(context({ maxLotPerOrder: 0 }), 'LOT_TOO_LARGE', 'LOT_TOO_LARGE');
  });

  it('disconnected broker → rejected', () => {
    const decision = evaluatePreTradeRisk(context({ account: account({ status: 'DISCONNECTED' }) }));
    expect(decision.passed).toBe(false);
    expect(decision.rejectionReason).toBe('BROKER_DISCONNECTED');
  });

  it('duplicate signal → rejected', () => {
    const decision = evaluatePreTradeRisk(context({ duplicate: true }));
    expect(decision.passed).toBe(false);
    expect(decision.rejectionReason).toBe('DUPLICATE_SIGNAL');
  });

  it('an unknown master equity floor (NaN) is fail-closed too', () => {
    const decision = evaluatePreTradeRisk(context({ masterEquityFloorUsd: Number.NaN }));
    expect(decision.passed).toBe(false);
    expect(decision.rejectionReason).toBe('MASTER_EQUITY_FLOOR_BREACHED');
  });
});

describe('evaluatePreTradeRisk: first failure in documented order', () => {
  /** A context in which all nine rules fail simultaneously. */
  function allBroken(): RiskContextWithFloor {
    return context({
      account: account({ isTradingEnabled: false, status: 'DISCONNECTED', rawState: 'DEPLOY_FAILED', equity: 0 }),
      duplicate: true,
      capitalUsd: 0,
      peakEquity: 0,
      currentEquity: 0,
      maxDrawdownPct: 0,
      openPositions: 99,
      maxOpenPositions: 1,
      signalVolume: 99,
      maxLotPerOrder: 1,
      symbolTradable: false,
      requiredMargin: null,
      freeMargin: 0,
    });
  }

  it('with every rule broken, the reported reason is the FIRST rule (ACCOUNT_NOT_ACTIVE)', () => {
    const decision = evaluatePreTradeRisk(allBroken());
    expect(decision.passed).toBe(false);
    expect(decision.rejectionReason).toBe('ACCOUNT_NOT_ACTIVE');
    expect(decision.checks.every((entry) => !entry.passed)).toBe(true);
    expect(decision.checks).toHaveLength(9);
  });

  it('repairing rules one at a time walks the rejection down the documented order', () => {
    const partials: Array<{ reason: RiskRejectionReason; ctx: RiskContextWithFloor }> = [
      {
        reason: 'BROKER_DISCONNECTED',
        ctx: context({ ...allBroken(), account: account({ isTradingEnabled: true, status: 'DISCONNECTED', equity: 0 }) }),
      },
      {
        reason: 'DUPLICATE_SIGNAL',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 0 }),
        }),
      },
      {
        reason: 'MASTER_EQUITY_FLOOR_BREACHED',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 0 }),
          duplicate: false,
        }),
      },
      {
        reason: 'DRAWDOWN_BREACHED',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 10000 }),
          duplicate: false,
        }),
      },
      {
        reason: 'MAX_OPEN_POSITIONS_REACHED',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 10000 }),
          duplicate: false,
          capitalUsd: 10000,
          peakEquity: 11000,
          currentEquity: 10000,
          maxDrawdownPct: 20,
        }),
      },
      {
        reason: 'LOT_TOO_LARGE',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 10000 }),
          duplicate: false,
          capitalUsd: 10000,
          peakEquity: 11000,
          currentEquity: 10000,
          maxDrawdownPct: 20,
          openPositions: 3,
          maxOpenPositions: 50,
        }),
      },
      {
        reason: 'SYMBOL_NOT_TRADABLE',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 10000 }),
          duplicate: false,
          capitalUsd: 10000,
          peakEquity: 11000,
          currentEquity: 10000,
          maxDrawdownPct: 20,
          openPositions: 3,
          maxOpenPositions: 50,
          signalVolume: 1,
          maxLotPerOrder: 10,
        }),
      },
      {
        reason: 'INSUFFICIENT_FREE_MARGIN',
        ctx: context({
          ...allBroken(),
          account: account({ isTradingEnabled: true, status: 'CONNECTED', equity: 10000 }),
          duplicate: false,
          capitalUsd: 10000,
          peakEquity: 11000,
          currentEquity: 10000,
          maxDrawdownPct: 20,
          openPositions: 3,
          maxOpenPositions: 50,
          signalVolume: 1,
          maxLotPerOrder: 10,
          symbolTradable: true,
          requiredMargin: null,
          freeMargin: 9000,
        }),
      },
    ];

    for (const { reason, ctx } of partials) {
      const decision = evaluatePreTradeRisk(ctx);
      expect(decision.rejectionReason, `expected ${reason}`).toBe(reason);
      // The failing rule is the FIRST failing check.
      const firstFailure = decision.checks.findIndex((entry) => !entry.passed);
      expect(decision.checks[firstFailure]?.reason).toBe(reason);
    }
  });

  it('later failures do not mask an earlier one (symbol + margin + lot + duplicate)', () => {
    expect(
      evaluatePreTradeRisk(
        context({ duplicate: true, symbolTradable: false, requiredMargin: null, signalVolume: 99, maxLotPerOrder: 1 }),
      ).rejectionReason,
    ).toBe('DUPLICATE_SIGNAL');

    expect(
      evaluatePreTradeRisk(
        context({ symbolTradable: false, requiredMargin: null, signalVolume: 99, maxLotPerOrder: 1 }),
      ).rejectionReason,
    ).toBe('LOT_TOO_LARGE');

    expect(evaluatePreTradeRisk(context({ symbolTradable: false, requiredMargin: null })).rejectionReason).toBe(
      'SYMBOL_NOT_TRADABLE',
    );
  });
});

describe('computeDrawdownPct', () => {
  it('computes the documented percentage exactly: peak 11000, current 9350, capital 10000 → 16.5', () => {
    expect(computeDrawdownPct(11000, 9350, 10000)).toBe(16.5);
    expect(computeDrawdownPct('11000', '9350', '10000')).toBe(16.5);
  });

  it('returns Infinity (fail-closed) when capital is zero or negative', () => {
    expect(computeDrawdownPct(11000, 9350, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(computeDrawdownPct(11000, 9350, -100)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(computeDrawdownPct(11000, 9350, 0))).toBe(false);
  });

  it('reports a negative drawdown honestly when equity is above the peak (no clamp to 0)', () => {
    expect(computeDrawdownPct(10000, 11000, 10000)).toBe(-10);
  });

  it('is a percentage of capital at risk, not of the peak: same delta, bigger base → smaller pct', () => {
    expect(computeDrawdownPct(11000, 9000, 10000)).toBe(20);
    expect(computeDrawdownPct(11000, 9000, 20000)).toBe(10);
  });
});
