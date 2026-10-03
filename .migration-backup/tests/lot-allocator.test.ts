import { describe, it, expect } from 'vitest';
import { Decimal, D } from '@/lib/money';
import {
  MASTER_TO_CLIENT_FORMULA,
  allocateAcrossInvestments,
  allocateLot,
  roundToVolumeStep,
  type AllocationInvestment,
  type AllocationSpec,
} from '@/server/modules/bot/lot.allocator';

/**
 * MASTER → CLIENT LOT ALLOCATION SUITE.
 *
 *   Client Lot Size = Master Lot Size * (Client Investment Capital / Master Account Equity)
 *
 * The safety property that matters most: the platform must NEVER give a client
 * more exposure than their proportional share, and the sum of the mirrored
 * client lots must never exceed the master lot (no over-mirroring). Rounding is
 * therefore always DOWN to the symbol's volume step.
 *
 * Money/volume assertions compare Decimals or exact decimal strings — never
 * `toBeCloseTo`, because loose float comparison is exactly how a 1-cent/0.01-lot
 * over-allocation would slip through.
 */

const SPEC: AllocationSpec = { volumeStep: 0.01, minVolume: 0.01, maxVolume: 100 };

function investment(investmentId: string, capitalUsd: string | null, maxVolume?: string): AllocationInvestment {
  return { investmentId, capitalUsd, ...(maxVolume === undefined ? {} : { maxVolume }) };
}

function lotOf(volume: number): Decimal {
  return D(volume);
}

/** Seeded PRNG (mulberry32) — deterministic, no flaky randomness. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('MASTER_TO_CLIENT_FORMULA', () => {
  it('is the documented copy-trade identity (the UI/audit text must match the implementation)', () => {
    expect(MASTER_TO_CLIENT_FORMULA).toBe(
      'Client Lot Size = Master Lot Size * (Client Investment Capital / Master Account Equity)',
    );
  });

  it('scales exactly: master 1.00 lot, equity 10000, capital 2500 → 0.25 client lots', () => {
    const result = allocateLot({
      masterVolume: 1,
      masterEquity: '10000.00',
      symbolSpec: SPEC,
      investment: investment('inv-a', '2500.00'),
      minClientCapitalUsd: 100,
    });
    expect(result.skipped).toBe(false);
    expect(lotOf(result.clientVolume).toFixed(2)).toBe('0.25');
    expect(result.ratio).toBe(0.25);
  });

  it('floors an exact-third split conservatively: master 2.1, equity 3, capital 1 → 0.69', () => {
    // ratio = 1/3 = 0.33333…(40 significant digits) and 2.1 × ratio =
    // 0.69999…5, so flooring to the 0.01 step yields 0.69 — one step BELOW the
    // mathematical 0.70. That is the documented direction of the error: the
    // allocator may under-mirror a share, never over-mirror it.
    const result = allocateLot({
      masterVolume: '2.1',
      masterEquity: '3',
      symbolSpec: SPEC,
      investment: investment('inv-b', '1'),
      minClientCapitalUsd: 0,
    });
    expect(result.skipped).toBe(false);
    expect(lotOf(result.clientVolume).toFixed(2)).toBe('0.69');
    // Conservation: the client never receives more than the exact share.
    expect(lotOf(result.clientVolume).lessThanOrEqualTo(D('2.1').times(D('1').div(D('3'))))).toBe(true);
  });

  it('keeps 5-dp volume steps exact (0.001 step → 3-dp client volume)', () => {
    const result = allocateLot({
      masterVolume: '0.5',
      masterEquity: '10000',
      symbolSpec: { volumeStep: 0.001, minVolume: 0.001, maxVolume: 100 },
      investment: investment('inv-c', '3333.33'),
      minClientCapitalUsd: 0,
    });
    expect(result.skipped).toBe(false);
    // raw = 0.5 * 0.333333 = 0.1666665 → floor to 0.166, never 0.167
    expect(lotOf(result.clientVolume).toFixed(3)).toBe('0.166');
  });
});

describe('rounding always goes DOWN', () => {
  it('floors to the volume step instead of rounding to nearest: raw 0.339 → 0.33 (never 0.34)', () => {
    const result = allocateLot({
      masterVolume: 1,
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-round', '3390'),
      minClientCapitalUsd: 0,
    });
    expect(result.skipped).toBe(false);
    expect(lotOf(result.clientVolume).toFixed(2)).toBe('0.33');
    expect(lotOf(result.clientVolume).lessThan(0.339)).toBe(true);
  });

  it('roundToVolumeStep never rounds up, and returns 0 below one step', () => {
    expect(roundToVolumeStep('0.339', 0.01).toFixed(2)).toBe('0.33');
    expect(roundToVolumeStep('0.3399999999', 0.01).toFixed(2)).toBe('0.33');
    expect(roundToVolumeStep('0.9999', 1).toFixed(2)).toBe('0.00');
    expect(roundToVolumeStep('1', 1).toFixed(2)).toBe('1.00');
    expect(roundToVolumeStep('0.005', 0.01).toFixed(2)).toBe('0.00');
    expect(roundToVolumeStep('-5', 0.01).toFixed(2)).toBe('0.00'); // negative volumes are refused
    expect(roundToVolumeStep('5', 0).toFixed(2)).toBe('0.00'); // a zero step cannot be honoured
  });

  it('every client volume is an exact multiple of the volume step', () => {
    const rand = mulberry32(0xa110c);
    for (let i = 0; i < 300; i += 1) {
      const capital = (Math.round(rand() * 20_000_00) / 100).toFixed(2);
      const masterVolume = (Math.round(rand() * 500) / 100).toFixed(2);
      const result = allocateLot({
        masterVolume,
        masterEquity: '10000',
        symbolSpec: SPEC,
        investment: investment(`inv-${i}`, capital),
        minClientCapitalUsd: 0,
      });
      if (result.skipped) continue;
      const steps = lotOf(result.clientVolume).div(SPEC.volumeStep);
      expect(steps.isInteger()).toBe(true);
      expect(lotOf(result.clientVolume).isNegative()).toBe(false);
    }
  });
});

describe('skip reasons', () => {
  const base = {
    masterVolume: 1,
    symbolSpec: SPEC,
    minClientCapitalUsd: 100,
  };

  it('masterEquity 0 → MASTER_EQUITY_ZERO (never a guessed ratio)', () => {
    const result = allocateLot({ ...base, masterEquity: 0, investment: investment('inv-zero', '5000') });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('MASTER_EQUITY_ZERO');
    expect(result.clientVolume).toBe(0);
  });

  it('negative masterEquity → MASTER_EQUITY_ZERO', () => {
    const result = allocateLot({ ...base, masterEquity: '-100', investment: investment('inv-neg', '5000') });
    expect(result.skipReason).toBe('MASTER_EQUITY_ZERO');
  });

  it('non-finite masterEquity (Infinity) → MASTER_EQUITY_ZERO', () => {
    const result = allocateLot({
      ...base,
      masterEquity: Number.POSITIVE_INFINITY,
      investment: investment('inv-inf', '5000'),
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('MASTER_EQUITY_ZERO');
    expect(result.clientVolume).toBe(0);
  });

  it('capital below minClientCapitalUsd → BELOW_MIN_CAPITAL (volume 0)', () => {
    const result = allocateLot({ ...base, masterEquity: '10000', investment: investment('inv-small', '99.99') });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('BELOW_MIN_CAPITAL');
    expect(result.clientVolume).toBe(0);
  });

  it('unknown capital (null) → CAPITAL_UNKNOWN, not a fabricated zero-capital allocation', () => {
    const result = allocateLot({ ...base, masterEquity: '10000', investment: investment('inv-null', null) });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('CAPITAL_UNKNOWN');
    expect(result.clientVolume).toBe(0);
  });

  it('scaled volume flooring below minVolume → BELOW_MIN_VOLUME (volume 0, never rounded up)', () => {
    // capital 5000 / equity 10000 = 0.5 ratio; master 0.01 lot → raw 0.005 → floor 0.00
    const result = allocateLot({ ...base, masterEquity: '10000', investment: investment('inv-tiny', '5000') });
    const withTinyMaster = allocateLot({
      masterVolume: '0.01',
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-tiny', '5000'),
      minClientCapitalUsd: 100,
    });
    expect(result.skipped).toBe(false);
    expect(withTinyMaster.skipped).toBe(true);
    expect(withTinyMaster.skipReason).toBe('BELOW_MIN_VOLUME');
    expect(withTinyMaster.clientVolume).toBe(0);
  });

  it('a floored-to-zero allocation is skipped rather than sent as a 0.00 order', () => {
    const result = allocateLot({
      masterVolume: '0.01',
      masterEquity: '10000',
      symbolSpec: { volumeStep: 0.01, minVolume: 0.01, maxVolume: 100 },
      investment: investment('inv-zero-lot', '4000'),
      minClientCapitalUsd: 0,
    });
    expect(result.skipped).toBe(true);
    expect(result.clientVolume).toBe(0);
  });

  it('masterVolume 0/negative → skipped, never a negative client lot', () => {
    for (const masterVolume of ['0', '-1']) {
      const result = allocateLot({
        ...base,
        masterEquity: '10000',
        masterVolume,
        investment: investment('inv-mv', '5000'),
      });
      expect(result.skipped).toBe(true);
      expect(result.clientVolume).toBe(0);
      expect(result.skipReason).toBe('BELOW_MIN_VOLUME');
    }
  });
});

describe('safety: never NaN/Infinity/negative, never over-mirrored', () => {
  it('clamps to the symbol max volume instead of exceeding it', () => {
    const result = allocateLot({
      masterVolume: '50',
      masterEquity: '100',
      symbolSpec: { volumeStep: 0.01, minVolume: 0.01, maxVolume: 2 },
      investment: investment('inv-clamp', '100'),
      minClientCapitalUsd: 0,
    });
    expect(result.skipped).toBe(false);
    expect(lotOf(result.clientVolume).toFixed(2)).toBe('2.00');
  });

  it('honours a per-investment max volume below the symbol max', () => {
    const result = allocateLot({
      masterVolume: '10',
      masterEquity: '100',
      symbolSpec: { volumeStep: 0.01, minVolume: 0.01, maxVolume: 100 },
      investment: investment('inv-cap', '100', '0.5'),
      minClientCapitalUsd: 0,
    });
    expect(lotOf(result.clientVolume).toFixed(2)).toBe('0.50');
  });

  it('sum of client lots never exceeds the master lot (master position is never over-mirrored)', () => {
    const rand = mulberry32(0xbeef_1234);
    for (let round = 0; round < 200; round += 1) {
      const masterVolume = (Math.round(rand() * 1000) / 100).toFixed(2);
      const masterEquity = '100000';
      const count = 1 + Math.floor(rand() * 12);

      // Split the master equity exactly, so sum(capital) <= masterEquity always.
      const weights = Array.from({ length: count }, () => 1 + rand() * 9);
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const investments = weights.map((w, index) =>
        investment(`inv-${index.toString().padStart(3, '0')}`, ((Number(masterEquity) * w) / weightSum).toFixed(2)),
      );

      const allocations = allocateAcrossInvestments({
        masterVolume,
        masterEquity,
        symbolSpec: SPEC,
        minClientCapitalUsd: 0,
        investments,
      });

      const total = allocations.reduce((acc, allocation) => acc.plus(lotOf(allocation.clientVolume)), new Decimal(0));
      expect(total.lessThanOrEqualTo(D(masterVolume))).toBe(true);

      for (const allocation of allocations) {
        expect(Number.isFinite(allocation.clientVolume)).toBe(true);
        expect(allocation.clientVolume).toBeGreaterThanOrEqual(0);
        expect(lotOf(allocation.clientVolume).isNegative()).toBe(false);

        // Rounding down means the client is never above the proportional share:
        //   clientVolume <= masterVolume * (clientCapital / masterEquity)
        const source = investments.find((item) => item.investmentId === allocation.investmentId);
        expect(source).toBeDefined();
        const rawShare = D(masterVolume).times(D(source?.capitalUsd ?? '0')).div(D(masterEquity));
        expect(lotOf(allocation.clientVolume).lessThanOrEqualTo(rawShare)).toBe(true);
      }
    }
  });

  it('is monotone in capital: a larger client never receives a smaller lot', () => {
    const small = allocateLot({
      masterVolume: '1',
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-small', '2000'),
      minClientCapitalUsd: 0,
    });
    const large = allocateLot({
      masterVolume: '1',
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-large', '8000'),
      minClientCapitalUsd: 0,
    });
    expect(lotOf(small.clientVolume).lessThanOrEqualTo(lotOf(large.clientVolume))).toBe(true);
    expect(lotOf(small.clientVolume).toFixed(2)).toBe('0.20');
    expect(lotOf(large.clientVolume).toFixed(2)).toBe('0.80');
  });

  it('handles NaN inputs fail-closed: skip with a reason, never a NaN lot', () => {
    const nanEquity = allocateLot({
      masterVolume: 1,
      masterEquity: Number.NaN,
      symbolSpec: SPEC,
      investment: investment('inv-nan', '5000'),
      minClientCapitalUsd: 0,
    });
    expect(nanEquity.skipped).toBe(true);
    expect(nanEquity.skipReason).toBe('MASTER_EQUITY_ZERO');
    expect(nanEquity.clientVolume).toBe(0);

    const nanCapital = allocateLot({
      masterVolume: 1,
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-nan-capital', Number.NaN as unknown as string),
      minClientCapitalUsd: 0,
    });
    expect(nanCapital.skipped).toBe(true);
    expect(nanCapital.skipReason).toBe('CAPITAL_UNKNOWN');
    expect(nanCapital.clientVolume).toBe(0);

    const nanVolume = allocateLot({
      masterVolume: Number.NaN,
      masterEquity: '10000',
      symbolSpec: SPEC,
      investment: investment('inv-nan-volume', '5000'),
      minClientCapitalUsd: 0,
    });
    expect(nanVolume.skipped).toBe(true);
    expect(nanVolume.skipReason).toBe('BELOW_MIN_VOLUME');
    expect(nanVolume.clientVolume).toBe(0);
    // No NaN ever reaches a broker order.
    for (const result of [nanEquity, nanCapital, nanVolume]) {
      expect(Number.isNaN(result.clientVolume)).toBe(false);
      expect(Number.isNaN(result.ratio)).toBe(false);
    }
  });
});

describe('allocateAcrossInvestments', () => {
  it('is deterministic and ordered by investmentId (byte-identical across runs)', () => {
    const input = {
      masterVolume: '1',
      masterEquity: '10000',
      symbolSpec: SPEC,
      minClientCapitalUsd: 100,
      investments: [
        investment('inv-c', '3000'),
        investment('inv-a', '1000'),
        investment('inv-b', '2000'),
      ],
    };
    const first = allocateAcrossInvestments(input);
    const second = allocateAcrossInvestments(input);
    expect(first.map((a) => a.investmentId)).toEqual(['inv-a', 'inv-b', 'inv-c']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((a) => a.clientVolume)).toEqual([0.1, 0.2, 0.3]);
  });

  it('does not mutate the caller’s array', () => {
    const list = [investment('inv-z', '1000'), investment('inv-a', '1000')];
    allocateAcrossInvestments({
      masterVolume: '1',
      masterEquity: '10000',
      symbolSpec: SPEC,
      minClientCapitalUsd: 0,
      investments: list,
    });
    expect(list.map((i) => i.investmentId)).toEqual(['inv-z', 'inv-a']);
  });

  it('handles an empty investment list without inventing anything', () => {
    expect(
      allocateAcrossInvestments({
        masterVolume: '1',
        masterEquity: '10000',
        symbolSpec: SPEC,
        minClientCapitalUsd: 0,
        investments: [],
      }),
    ).toEqual([]);
  });
});
