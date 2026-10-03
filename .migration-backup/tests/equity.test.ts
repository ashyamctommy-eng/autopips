import { describe, it, expect } from 'vitest';
import { Decimal, D, sum, type Numeric } from '@/lib/money';
import {
  CREDITED_PAYMENT_STATUSES,
  DEBITED_PAYMENT_STATUSES,
  EQUITY_FORMULA,
  assertEquityConsistency,
  computeEquity,
  computeWithdrawableBalance,
  type EquityInputs,
} from '@/server/accounting/equity';

/**
 * ACCOUNTING INTEGRITY SUITE — the straight-line equity formula.
 *
 *   Equity = Starting Capital + Realized P/L + Unrealized P/L
 *            - Deducted Fees - Withdrawals + Confirmed Deposits
 *
 * Every assertion below compares Decimals or exact cent strings. `toBeCloseTo`
 * on a float is deliberately NOT used anywhere in this file: floating-point
 * tolerance is precisely the bug class this suite exists to catch (a hidden
 * float pipeline would drift by cents and still pass a fuzzy comparison).
 *
 * The "expected" values are hand-computed in the scenario table comments so a
 * reviewer can verify the arithmetic without running the code.
 */

function zeroInputs(): EquityInputs {
  return {
    startingCapital: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    deductedFees: 0,
    withdrawals: 0,
    confirmedDeposits: 0,
  };
}

function inputs(partial: Partial<EquityInputs>): EquityInputs {
  return { ...zeroInputs(), ...partial };
}

/**
 * INDEPENDENT re-implementation of the formula for cross-checking.
 *
 * Deliberately written differently from the module (explicit string coercion +
 * fresh `new Decimal(...)`), so that a shared mistake in `D()`/`usd()` cannot
 * make both sides agree.
 */
function manualEquity(input: EquityInputs): Decimal {
  const asCents = (value: Numeric): Decimal => new Decimal(D(value).toFixed(2));
  let acc = new Decimal('0');
  acc = acc.plus(asCents(input.startingCapital));
  acc = acc.plus(asCents(input.realizedPnL));
  acc = acc.plus(asCents(input.unrealizedPnL));
  acc = acc.minus(asCents(input.deductedFees));
  acc = acc.minus(asCents(input.withdrawals));
  acc = acc.plus(asCents(input.confirmedDeposits));
  return acc.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Seeded PRNG (mulberry32) — deterministic, never Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random 2-dp money value in whole cents, from a seeded stream. */
function randomCents(rand: () => number, magnitude = 1_000_000): string {
  const cents = Math.round((rand() * 2 - 1) * magnitude);
  return new Decimal(cents).div(100).toFixed(2);
}

describe('equity formula: documented identity', () => {
  it('exposes the formula it implements (guards against silent rewording of the contract)', () => {
    expect(EQUITY_FORMULA).toBe(
      'Equity = Starting Capital + Realized P/L + Unrealized P/L - Deducted Fees - Withdrawals + Confirmed Deposits',
    );
  });

  it('counts CONFIRMED and FINISHED deposits as credited, and only FINISHED withdrawals as debited', () => {
    expect([...CREDITED_PAYMENT_STATUSES]).toEqual(['CONFIRMED', 'FINISHED']);
    expect([...DEBITED_PAYMENT_STATUSES]).toEqual(['FINISHED']);
  });
});

describe('equity formula: hand-computed scenarios', () => {
  interface Scenario {
    name: string;
    input: EquityInputs;
    expectedEquity: string;
    expectedNetProfit?: string;
    expectedGrossPnL?: string;
  }

  const scenarios: Scenario[] = [
    {
      name: 'all components zero → zero equity (a fresh, unfunded account shows 0.00, not a placeholder)',
      input: zeroInputs(),
      expectedEquity: '0.00',
      expectedNetProfit: '0.00',
      expectedGrossPnL: '0.00',
    },
    {
      name: 'profit only: 10000 + 250 realized → 10250.00',
      input: inputs({ startingCapital: '10000.00', realizedPnL: '250.00' }),
      expectedEquity: '10250.00',
      expectedNetProfit: '250.00',
      expectedGrossPnL: '250.00',
    },
    {
      name: 'loss only: 10000 - 250 realized → 9750.00',
      input: inputs({ startingCapital: '10000.00', realizedPnL: '-250.00' }),
      expectedEquity: '9750.00',
      expectedNetProfit: '-250.00',
    },
    {
      name: 'losses exceeding capital: 1000 - 3500 - 200 → -2700.00 (negative equity must be REPORTED, never clamped to 0)',
      input: inputs({ startingCapital: '1000.00', realizedPnL: '-3500.00', unrealizedPnL: '-200.00' }),
      expectedEquity: '-2700.00',
      expectedNetProfit: '-3700.00',
      expectedGrossPnL: '-3700.00',
    },
    {
      name: 'fees + withdrawals + deposits all applied: 10000 + 500 + 120 - 75.55 - 1000 + 2000 → 11544.45',
      input: inputs({
        startingCapital: '10000.00',
        realizedPnL: '500.00',
        unrealizedPnL: '120.00',
        deductedFees: '75.55',
        withdrawals: '1000.00',
        confirmedDeposits: '2000.00',
      }),
      expectedEquity: '11544.45',
      expectedNetProfit: '544.45', // gross 620.00 - fees 75.55
    },
    {
      name: 'withdrawal equal to the whole equity: 1000 + 100 - 1100 → 0.00 (account emptied, not negative)',
      input: inputs({ startingCapital: '1000.00', realizedPnL: '100.00', withdrawals: '1100.00' }),
      expectedEquity: '0.00',
      expectedNetProfit: '100.00',
    },
    {
      name: 'small withdrawal overshooting equity: 100 - 150 → -50.00 (honest negative, still no clamp)',
      input: inputs({ startingCapital: '100.00', withdrawals: '150.00' }),
      expectedEquity: '-50.00',
    },
    {
      name: 'cent drift: 0.1 + 0.2 must be exactly 0.30 (IEEE-754 would give 0.30000000000000004)',
      input: inputs({ startingCapital: 0.1, realizedPnL: 0.2 }),
      expectedEquity: '0.30',
    },
    {
      name: 'three-way cent drift: 0.1 + 0.2 + 0.3 - 0.3 → 0.30',
      input: inputs({ startingCapital: 0.1, realizedPnL: 0.2, unrealizedPnL: 0.3, deductedFees: 0.3 }),
      expectedEquity: '0.30',
    },
    {
      name: '10,000 rows of 0.01 sum to exactly 100.00 (float accumulation drifts to 100.00000000001425)',
      input: inputs({ realizedPnL: sum(Array.from({ length: 10_000 }, () => D('0.01'))) }),
      expectedEquity: '100.00',
      expectedNetProfit: '100.00',
    },
    {
      name: 'large values near the Decimal(18,2) column limit stay exact',
      input: inputs({
        startingCapital: '999999999999.99',
        realizedPnL: '0.01',
        deductedFees: '0.01',
        confirmedDeposits: '0.01',
      }),
      expectedEquity: '1000000000000.00',
    },
    {
      name: 'large minus large: 1234567890123456.78 + 0.11 → 1234567890123456.89',
      input: inputs({ startingCapital: '1234567890123456.78', realizedPnL: '0.11' }),
      expectedEquity: '1234567890123456.89',
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const result = computeEquity(scenario.input);
      // Exact cent-string comparison — no tolerance.
      expect(result.equity.toFixed(2)).toBe(scenario.expectedEquity);
      // The independent re-implementation must agree exactly.
      expect(manualEquity(scenario.input).toFixed(2)).toBe(scenario.expectedEquity);
      if (scenario.expectedNetProfit !== undefined) {
        expect(result.netProfit.toFixed(2)).toBe(scenario.expectedNetProfit);
      }
      if (scenario.expectedGrossPnL !== undefined) {
        expect(result.grossPnL.toFixed(2)).toBe(scenario.expectedGrossPnL);
      }
      // Never a NaN/Infinity leaking into the DTO.
      expect(Number.isFinite(result.equity.toNumber())).toBe(true);
      expect(Number.isFinite(result.netReturnPct.toNumber())).toBe(true);
    });
  }

  it('a negative equity floor is never applied: no component of the breakdown is clamped', () => {
    const result = computeEquity(inputs({ startingCapital: '1000.00', realizedPnL: '-9000.00' }));
    expect(result.equity.toFixed(2)).toBe('-8000.00');
    expect(result.equity.isNegative()).toBe(true);
    // ...and the components are reported verbatim so the client can see why.
    expect(result.startingCapital.toFixed(2)).toBe('1000.00');
    expect(result.realizedPnL.toFixed(2)).toBe('-9000.00');
  });
});

describe('equity formula: netReturnPct zero-guard', () => {
  it('returns exactly 0 (never NaN/Infinity) when startingCapital is 0', () => {
    const result = computeEquity(inputs({ startingCapital: 0, realizedPnL: '500.00' }));
    expect(result.netReturnPct.isZero()).toBe(true);
    expect(result.netReturnPct.toFixed(4)).toBe('0.0000');
    expect(Number.isFinite(result.netReturnPct.toNumber())).toBe(true);
    expect(result.netProfit.toFixed(2)).toBe('500.00');
  });

  it('returns 0 for an all-zero account as well (0/0 is not a return)', () => {
    const result = computeEquity(zeroInputs());
    expect(result.netReturnPct.toFixed(4)).toBe('0.0000');
  });

  it('computes the return against starting capital, not deposits: 1000 capital, 620 gross, 75.55 fees → 5.4445%', () => {
    const result = computeEquity(
      inputs({
        startingCapital: '10000.00',
        realizedPnL: '500.00',
        unrealizedPnL: '120.00',
        deductedFees: '75.55',
      }),
    );
    expect(result.netReturnPct.toFixed(4)).toBe('5.4445');
  });
});

describe('equity formula: property test (500 seeded random ledgers)', () => {
  it('agrees with the independent Decimal recomputation, and zero-valued components never change it', () => {
    const rand = mulberry32(0x5eed_1eaf);

    for (let i = 0; i < 500; i += 1) {
      const input: EquityInputs = {
        startingCapital: randomCents(rand, 100_000_000),
        realizedPnL: randomCents(rand, 10_000_000),
        unrealizedPnL: randomCents(rand, 1_000_000),
        deductedFees: randomCents(rand, 100_000),
        withdrawals: randomCents(rand, 5_000_000),
        confirmedDeposits: randomCents(rand, 50_000_000),
      };

      const result = computeEquity(input);
      expect(result.equity.toFixed(2)).toBe(manualEquity(input).toFixed(2));

      // Adding a zero-valued component (in any Numeric representation) must not
      // move the number by even a cent.
      const withZeros: EquityInputs = {
        startingCapital: D(input.startingCapital).plus(new Decimal(0)),
        realizedPnL: D(input.realizedPnL).toFixed(2), // string form
        unrealizedPnL: D(input.unrealizedPnL).toNumber(), // number form
        deductedFees: D(input.deductedFees).plus(0),
        withdrawals: D(input.withdrawals),
        confirmedDeposits: D(input.confirmedDeposits).plus('0.00'),
      };
      expect(computeEquity(withZeros).equity.toFixed(2)).toBe(result.equity.toFixed(2));

      // Numeric-kind invariance: Decimal / string / number of the same value.
      const asDecimals: EquityInputs = {
        startingCapital: D(input.startingCapital),
        realizedPnL: D(input.realizedPnL),
        unrealizedPnL: D(input.unrealizedPnL),
        deductedFees: D(input.deductedFees),
        withdrawals: D(input.withdrawals),
        confirmedDeposits: D(input.confirmedDeposits),
      };
      expect(computeEquity(asDecimals).equity.toFixed(2)).toBe(result.equity.toFixed(2));
    }
  });

  it('zero-valued components in every representation produce an identical zero result', () => {
    const variants: Numeric[] = [0, '0', '0.00', new Decimal(0), D('0.000')];
    for (const zero of variants) {
      const result = computeEquity(inputs({ startingCapital: zero, realizedPnL: zero, unrealizedPnL: zero }));
      expect(result.equity.toFixed(2)).toBe('0.00');
      const withZeroFee = computeEquity(inputs({ startingCapital: zero, deductedFees: zero, withdrawals: zero }));
      expect(withZeroFee.equity.toFixed(2)).toBe('0.00');
    }
  });

  it('a naive float pipeline would drift — proving the Decimal requirement is not decorative', () => {
    // Control experiment: the same ledger computed with IEEE-754 doubles.
    let floatTotal = 0;
    for (let i = 0; i < 10_000; i += 1) floatTotal += 0.01;
    expect(floatTotal).not.toBe(100);
    expect(floatTotal).toBeCloseTo(100, 6); // 100.00000000001425 — a cent-scale bug generator
    // The ledger computes the same sum exactly.
    const exact = sum(Array.from({ length: 10_000 }, () => D('0.01')));
    expect(exact.toFixed(2)).toBe('100.00');
    expect(D(0.1).plus(D(0.2)).toFixed(2)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});

describe('assertEquityConsistency', () => {
  const ledger = inputs({
    startingCapital: '10000.00',
    realizedPnL: '250.00',
    deductedFees: '12.34',
    confirmedDeposits: '1000.00',
  });
  // 10000 + 250 - 12.34 + 1000 = 11237.66
  const exact = '11237.66';

  it('passes on an exact match (also when the reported value is a string or number)', () => {
    expect(() => assertEquityConsistency(ledger, exact)).not.toThrow();
    expect(() => assertEquityConsistency(ledger, new Decimal(exact))).not.toThrow();
    expect(() => assertEquityConsistency(ledger, Number(exact))).not.toThrow();
  });

  it('throws on any discrepancy of two cents or more, in both directions', () => {
    expect(() => assertEquityConsistency(ledger, '11237.68')).toThrowError(/Accounting integrity violation/);
    expect(() => assertEquityConsistency(ledger, '11237.68')).toThrowError(/11237\.66/);
    expect(() => assertEquityConsistency(ledger, '11237.64')).toThrowError(/Accounting integrity violation/);
    expect(() => assertEquityConsistency(ledger, '11236.00')).toThrowError(/Accounting integrity violation/);
  });

  /**
   * ACCEPTANCE SPEC: "assertEquityConsistency throws on a 1-cent discrepancy".
   *
   * The implementation was tightened to `delta.greaterThanOrEqualTo('0.01')`,
   * so a delta of exactly 0.01 is now a violation in both directions and the
   * old one-cent blind spot is gone.
   *
   * SOURCE: src/server/accounting/equity.ts:171 (`if (delta.greaterThanOrEqualTo('0.01'))`)
   */
  it('SPEC: throws on a 1-cent discrepancy (delta of exactly 0.01)', () => {
    expect(() => assertEquityConsistency(ledger, '11237.67')).toThrowError(/Accounting integrity violation/);
    expect(() => assertEquityConsistency(ledger, '11237.65')).toThrowError(/Accounting integrity violation/);
  });
});

/**
 * CENT-STRICTNESS BOUNDARY — both sides of the `>= 0.01` comparison.
 *
 * The guard exists to catch silent drift: it must accept a delta of exactly
 * 0.00 (the ledger is right) and reject a delta of exactly 0.01 (one cent of
 * drift). Testing only one side is how the old `>` version hid a blind spot.
 */
describe('assertEquityConsistency: exact cent boundary (0.00 passes, 0.01 throws)', () => {
  const ledger = inputs({
    startingCapital: '10000.00',
    realizedPnL: '250.00',
    deductedFees: '12.34',
    confirmedDeposits: '1000.00',
  });
  // 10000.00 + 250.00 − 12.34 + 1000.00 = 11237.66
  const exact = '11237.66';

  it('a delta of exactly 0.00 passes, in every Numeric representation', () => {
    // the reported value really is the formula value (delta 0.00, not "small")
    expect(computeEquity(ledger).equity.toFixed(2)).toBe(exact);
    expect(computeEquity(ledger).equity.minus(exact).abs().toFixed(2)).toBe('0.00');

    expect(() => assertEquityConsistency(ledger, exact)).not.toThrow();
    expect(() => assertEquityConsistency(ledger, '11237.6600')).not.toThrow(); // padded cents
    expect(() => assertEquityConsistency(ledger, new Decimal(exact))).not.toThrow();
    expect(() => assertEquityConsistency(ledger, Number(exact))).not.toThrow();
  });

  it('a delta of exactly +0.01 throws (ledger reports one cent too much)', () => {
    const overReported = '11237.67'; // 11237.66 + 0.01
    expect(D(overReported).minus(exact).toFixed(2)).toBe('0.01');
    expect(() => assertEquityConsistency(ledger, overReported)).toThrowError(/Accounting integrity violation/);
    expect(() => assertEquityConsistency(ledger, overReported)).toThrowError(/11237\.67/);
  });

  it('a delta of exactly −0.01 throws (ledger reports one cent too little)', () => {
    const underReported = '11237.65'; // 11237.66 − 0.01
    expect(D(exact).minus(underReported).toFixed(2)).toBe('0.01');
    expect(() => assertEquityConsistency(ledger, underReported)).toThrowError(/Accounting integrity violation/);
    expect(() => assertEquityConsistency(ledger, underReported)).toThrowError(/11237\.65/);
  });

  it('the boundary is the ROUNDED cent: sub-cent noise passes, the first rounded cent throws', () => {
    // Reported values are quantised to 2 dp (ROUND_HALF_UP) before comparison —
    // only whole cents can ever be persisted in a Decimal(18,2) column.
    expect(() => assertEquityConsistency(ledger, '11237.6601')).not.toThrow(); // → 11237.66, delta 0.00
    expect(() => assertEquityConsistency(ledger, '11237.6649')).not.toThrow(); // → 11237.66, delta 0.00
    expect(() => assertEquityConsistency(ledger, '11237.665')).toThrowError(/Accounting integrity violation/); // → 11237.67, delta 0.01
    expect(() => assertEquityConsistency(ledger, '11237.6699')).toThrowError(/Accounting integrity violation/); // → 11237.67, delta 0.01
  });
});

describe('computeWithdrawableBalance', () => {
  it('never returns a negative number, even when deployed capital exceeds equity', () => {
    const result = computeWithdrawableBalance({
      equity: new Decimal('100.00'),
      activeCapital: '500.00',
      pendingWithdrawals: '100.00',
    });
    expect(result.toFixed(2)).toBe('0.00');
    expect(result.isNegative()).toBe(false);
  });

  it('subtracts deployed capital + pending withdrawals + minimum reserve', () => {
    // 1000 - 400 - 100 - 50 = 450.00
    const result = computeWithdrawableBalance({
      equity: new Decimal('1000.00'),
      activeCapital: '400.00',
      pendingWithdrawals: '100.00',
      minimumReserve: '50.00',
    });
    expect(result.toFixed(2)).toBe('450.00');
  });

  it('treats a missing reserve as zero and never invents a balance from nothing', () => {
    expect(
      computeWithdrawableBalance({ equity: new Decimal('0.00'), activeCapital: 0, pendingWithdrawals: 0 }).toFixed(2),
    ).toBe('0.00');
    expect(
      computeWithdrawableBalance({
        equity: new Decimal('10.00'),
        activeCapital: '10.00',
        pendingWithdrawals: 0,
      }).toFixed(2),
    ).toBe('0.00');
  });

  it('the negative equity case is not withdrawable at all (a debt is not a balance)', () => {
    const result = computeWithdrawableBalance({
      equity: new Decimal('-2700.00'),
      activeCapital: '0.00',
      pendingWithdrawals: '0.00',
    });
    expect(result.toFixed(2)).toBe('0.00');
  });
});
