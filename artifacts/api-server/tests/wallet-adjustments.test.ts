import { describe, expect, it } from 'vitest';
import { buildEquityFromAggregates } from '@/server/accounting/ledger';
import { adjustmentSchema } from '@/server/modules/admin/wallet-adjustment.service';

const base = { creditedDeposits: 100, deployedCapital: 0, paidWithdrawals: 0,
  realizedPnL: 0, unrealizedPnL: 0, deductedFees: 0 };
describe('audited cash allocations', () => {
  it('adds capital without inventing profit', () => {
    const result = buildEquityFromAggregates({ ...base, adminAdjustments: 50 });
    expect(result.equity.toNumber()).toBe(150);
    expect(result.netProfit.toNumber()).toBe(0);
  });
  it('does not double-count allocated capital', () => {
    const result = buildEquityFromAggregates({ ...base, creditedDeposits: 0, adminAdjustments: 100, deployedCapital: 75 });
    expect(result.equity.toNumber()).toBe(100);
  });
  it('debits idle profit even when all contributions are deployed', () => {
    const result = buildEquityFromAggregates({ ...base, deployedCapital: 100, realizedPnL: 50, adminAdjustments: -25 });
    expect(result.equity.toNumber()).toBe(125);
    expect(result.netProfit.toNumber()).toBe(50);
  });
  it.each([0, -1, 0.001, Infinity, NaN, 1e13])('refuses an invalid amount %s', amount => {
    expect(adjustmentSchema.safeParse({ userId: crypto.randomUUID(), amount, type: 'credit', reason: 'Verified allocation' }).success).toBe(false);
  });
});