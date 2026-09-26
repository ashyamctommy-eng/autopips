import './helpers/test-env';

import { describe, expect, it } from 'vitest';

import { computeWithdrawableBalance } from '@/server/accounting/equity';
import {
  AUTOMATIC_TERMINAL_STATUS,
  MANUAL_TERMINAL_STATUS,
  MATURITY_ELIGIBLE_STATUSES,
  MATURITY_TERMINAL_STATUSES,
  buildMaturityUpdate,
  decideMaturity,
  isTerminalInvestmentStatus,
  type MaturityCandidate,
} from '@/server/modules/account/maturity.logic';

/**
 * INVESTMENT MATURITY SUITE.
 *
 * The defect: nothing could move an `Investment` out of ACTIVE/PAUSED, so once
 * the ledger began excluding those statuses from `deployed` capital a client's
 * principal was locked forever. This suite pins the decision that releases it and
 * the accounting claim that makes the release safe.
 *
 * What is asserted here, and why each matters:
 *   1. the PURE verdict (due + flat -> mature; open position -> refuse; terminal
 *      -> refuse; not due -> refuse) — the rule the sweep and the manual close
 *      both delegate to;
 *   2. the transition patch writes EXACTLY { status, closedAt } and no money
 *      column, so maturity can never destroy `capitalUsd`;
 *   3. idempotency at the decision level: after the first sweep the row is
 *      terminal, so a second verdict refuses it instead of re-transitioning;
 *   4. equity NEUTRALITY against the REAL ledger assembler
 *      (`buildEquityFromAggregates`) — the same function `getAccountSnapshot`
 *      calls — showing that flipping a row out of `deployed` moves the same
 *      amount into `idle` and leaves equity and net contributed capital
 *      unchanged while the principal becomes withdrawable again.
 *
 * The service (sweep / manual close / admin list) is exercised through its pure
 * pieces on purpose: `maturity.service.ts` pulls in Prisma, Redis, the audit
 * table, the event bus and the broker SDK, so importing it would need a live
 * database and a `window` shim. Its idempotency layers (the per-investment claim
 * and the DB compare-and-swap) are structural — `claimOnce` + `updateMany(...)`
 * with `count === 1` — and are asserted by inspection in the file header, not by
 * a mock.
 */

// `ledger.ts` (which re-hosts `buildEquityFromAggregates`) imports the Prisma
// singleton. That constructor requires DATABASE_URL to be PRESENT — it never
// connects — and the CI `verify` job sets an unreachable dummy for exactly this
// reason. A bare sandbox with no `.env` does not, so supply the same dummy
// BEFORE the dynamic import evaluates the Prisma client. Static imports are
// hoisted, which is why this one is dynamic.
process.env.DATABASE_URL ??=
  'postgresql://verify:verify@127.0.0.1:5999/verify?schema=public';
const { DEPLOYED_INVESTMENT_STATUSES, buildEquityFromAggregates } = await import(
  '@/server/accounting/ledger'
);

const NOW = new Date('2026-09-26T12:00:00.000Z');
const DUE = new Date('2026-09-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-01T00:00:00.000Z');

function candidate(overrides: Partial<MaturityCandidate> = {}): MaturityCandidate {
  return {
    id: 'inv-1',
    status: 'ACTIVE',
    maturityDate: DUE,
    openTrades: 0,
    ...overrides,
  };
}

describe('investment maturity: pure decision', () => {
  it('matures an ACTIVE investment whose maturity date has passed and which has no open trades', () => {
    const decision = decideMaturity(candidate(), NOW);
    expect(decision.action).toBe('MATURE');
    if (decision.action !== 'MATURE') throw new Error('unreachable');
    expect(decision.status).toBe(AUTOMATIC_TERMINAL_STATUS);
    expect(decision.status).toBe('MATURED');
    expect(decision.reason).toBeNull();
  });

  it('matures at exactly the maturity instant (<= now, not < now)', () => {
    const decision = decideMaturity(candidate({ maturityDate: NOW }), NOW);
    expect(decision.action).toBe('MATURE');
  });

  it('matures a PAUSED investment too — pausing is not terminal', () => {
    const decision = decideMaturity(candidate({ status: 'PAUSED' }), NOW);
    expect(decision.action).toBe('MATURE');
  });

  it('refuses while a position is still open, and says why', () => {
    const decision = decideMaturity(candidate({ openTrades: 2 }), NOW);
    expect(decision.action).toBe('REFUSE');
    if (decision.action !== 'REFUSE') throw new Error('unreachable');
    expect(decision.reason).toBe('OPEN_TRADES');
    expect(decision.message).toContain('2 open position');
  });

  it('refuses an already-terminal investment', () => {
    for (const status of MATURITY_TERMINAL_STATUSES) {
      const decision = decideMaturity(candidate({ status }), NOW);
      expect(decision.action, status).toBe('REFUSE');
      if (decision.action !== 'REFUSE') throw new Error('unreachable');
      expect(decision.reason, status).toBe('ALREADY_TERMINAL');
    }
    expect(isTerminalInvestmentStatus('MATURED')).toBe(true);
    expect(isTerminalInvestmentStatus('CLOSED')).toBe(true);
    expect(isTerminalInvestmentStatus('CANCELLED')).toBe(true);
    expect(isTerminalInvestmentStatus('ACTIVE')).toBe(false);
    expect(isTerminalInvestmentStatus('PAUSED')).toBe(false);
  });

  it('refuses when the maturity date is still in the future', () => {
    const decision = decideMaturity(candidate({ maturityDate: FUTURE }), NOW);
    expect(decision.action).toBe('REFUSE');
    if (decision.action !== 'REFUSE') throw new Error('unreachable');
    expect(decision.reason).toBe('NOT_DUE');
  });

  it('refuses when there is no maturity date at all', () => {
    const decision = decideMaturity(candidate({ maturityDate: null }), NOW);
    expect(decision.action).toBe('REFUSE');
    if (decision.action !== 'REFUSE') throw new Error('unreachable');
    expect(decision.reason).toBe('NO_MATURITY_DATE');
  });

  it('is a strict no-op on a second sweep: the first matures, the second refuses the now-terminal row', () => {
    const before = candidate();
    const first = decideMaturity(before, NOW);
    expect(first.action).toBe('MATURE');

    // The sweep transitions the row; the next sweep reads MATURED with a closedAt
    // set and must refuse rather than re-transition, re-audit or re-publish.
    const afterRow = candidate({ status: 'MATURED' });
    const second = decideMaturity(afterRow, NOW);
    expect(second.action).toBe('REFUSE');
    if (second.action !== 'REFUSE') throw new Error('unreachable');
    expect(second.reason).toBe('ALREADY_TERMINAL');

    // And the decision is deterministic/stateless: repeating it changes nothing.
    expect(decideMaturity(afterRow, NOW)).toEqual(second);
  });

  it('pins the eligible statuses to the ledger defined deployed set', () => {
    expect([...MATURITY_ELIGIBLE_STATUSES]).toEqual([...DEPLOYED_INVESTMENT_STATUSES]);
  });
});

describe('investment maturity: the transition never touches money', () => {
  it('writes exactly { status, closedAt } — no capitalUsd, no P/L, no fees', () => {
    const closedAt = new Date('2026-09-26T12:00:00.000Z');
    const patch = buildMaturityUpdate({ closedAt });

    expect(Object.keys(patch).sort()).toEqual(['closedAt', 'status']);
    expect('capitalUsd' in patch).toBe(false);
    expect('realizedPnL' in patch).toBe(false);
    expect('unrealizedPnL' in patch).toBe(false);
    expect('feesDeducted' in patch).toBe(false);
    expect(patch.status).toBe(AUTOMATIC_TERMINAL_STATUS);
    expect(patch.closedAt).toBe(closedAt);
  });

  it('uses CLOSED only for a manual close', () => {
    const patch = buildMaturityUpdate({ targetStatus: MANUAL_TERMINAL_STATUS, closedAt: NOW });
    expect(patch.status).toBe('CLOSED');
  });
});

describe('investment maturity: equity neutrality against the real ledger maths', () => {
  // One client: $10,000 credited, ALL of it deployed, +$250 realized, $100 fees.
  // The row matures: the sweep flips only its status, so `deployed` falls by
  // $10,000 and `idle` (= credited - deployed) rises by exactly the same amount.
  const ledgerInputs = {
    creditedDeposits: '10000.00',
    paidWithdrawals: '0.00',
    realizedPnL: '250.00',
    unrealizedPnL: '0.00',
    deductedFees: '100.00',
  } as const;

  const deployed = buildEquityFromAggregates({ ...ledgerInputs, deployedCapital: '10000.00' });
  const matured = buildEquityFromAggregates({ ...ledgerInputs, deployedCapital: '0.00' });

  it('moves the same $10,000 from startingCapital into confirmedDeposits', () => {
    expect(deployed.startingCapital.toFixed(2)).toBe('10000.00');
    expect(deployed.confirmedDeposits.toFixed(2)).toBe('0.00');
    expect(matured.startingCapital.toFixed(2)).toBe('0.00');
    expect(matured.confirmedDeposits.toFixed(2)).toBe('10000.00');
    expect(
      matured.confirmedDeposits.minus(deployed.confirmedDeposits).toFixed(2),
    ).toBe(deployed.startingCapital.minus(matured.startingCapital).toFixed(2));
  });

  it('leaves equity unchanged by the transition', () => {
    // equity = 10000 + 0 + 250 - 100 in BOTH cases.
    expect(deployed.equity.toFixed(2)).toBe('10150.00');
    expect(matured.equity.toFixed(2)).toBe('10150.00');
    expect(deployed.equity.equals(matured.equity)).toBe(true);
  });

  it('leaves net contributed capital and the P/L identity unchanged', () => {
    expect(matured.netContributedCapital.toFixed(2)).toBe(deployed.netContributedCapital.toFixed(2));
    expect(matured.netProfit.toFixed(2)).toBe(deployed.netProfit.toFixed(2));
    expect(matured.netReturnPct.toFixed(4)).toBe(deployed.netReturnPct.toFixed(4));
  });

  it('releases the principal into withdrawable balance (the defect being fixed)', () => {
    const beforeClosure = computeWithdrawableBalance({
      equity: deployed.equity,
      activeCapital: '10000.00',
      pendingWithdrawals: '0.00',
    });
    const afterMaturity = computeWithdrawableBalance({
      equity: matured.equity,
      activeCapital: '0.00',
      pendingWithdrawals: '0.00',
    });

    // Before: all $10,000 is locked, only the $150 of profit is available.
    expect(beforeClosure.toFixed(2)).toBe('150.00');
    // After: the full equity (principal + profit) can be withdrawn.
    expect(afterMaturity.toFixed(2)).toBe('10150.00');
    expect(afterMaturity.minus(beforeClosure).toFixed(2)).toBe('10000.00');
  });

  it('demonstrates why zeroing capitalUsd would be wrong (the banned alternative)', () => {
    // Zeroing the capital column instead of flipping status would ALSO drop
    // `deployed`, but the client's capital would simply be gone: the ledger would
    // still show `credited = 0` only if the deposit were also removed. Here the
    // contrast is that equity is unchanged purely by the status flip — no write
    // to any money column is needed or permitted.
    expect(deployed.equity.equals(matured.equity)).toBe(true);
    expect(buildMaturityUpdate({ closedAt: NOW })).not.toHaveProperty('capitalUsd');
  });
});
