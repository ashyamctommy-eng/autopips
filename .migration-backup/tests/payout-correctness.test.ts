import './helpers/test-env';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@/lib/money';
import { ApiError } from '@/lib/http';
import {
  classifyIpnPayload,
  extractPayoutTxHash,
  mapPayoutStatusToPaymentStatus,
  parsePayoutIpnPayload,
} from '@/server/modules/payments/ipn.service';
import {
  decideTwoPersonApproval,
  exceedsPayoutDailyCap,
  isPayoutAddressAllowed,
  resolvePayoutCoinAmount,
} from '@/server/modules/payments/payments.service';

/**
 * PAYOUT CORRECTNESS — the pure-logic layer under the withdrawal fixes.
 *
 * Three properties are load-bearing enough to be pinned here, away from any
 * database or provider:
 *
 *   1. A USD figure may never be broadcast as a coin amount. A missing, zero,
 *      negative or non-finite provider estimate REFUSES the payout; there is no
 *      fallback branch, and these tests would fail the moment one is added.
 *   2. The IPN webhook carries two unrelated shapes on one URL. They must be
 *      told apart by shape, or every payout callback is answered with a 400 and
 *      the provider retries it forever.
 *   3. The operator controls (daily cap, allow-list, two-person approval) must
 *      not change behaviour when unconfigured — except the two-person rule,
 *      which defaults ON for automated broadcasts and must still never block a
 *      manual settlement.
 */

describe('payout conversion guard (USD must never be sent as a coin amount)', () => {
  const usdWithdrawal = {
    withdrawalId: 'wd_0123456789abcdef',
    amountUsd: 100,
    currency: 'btc',
  };

  it('returns the provider coin estimate, quantised to 8 decimal places', () => {
    const coin = resolvePayoutCoinAmount({
      ...usdWithdrawal,
      estimatedAmount: '0.000912345678912',
    });
    expect(coin).toBeInstanceOf(Decimal);
    expect(coin.toFixed(8)).toBe('0.00091235');
  });

  it('does NOT return the USD figure when the estimate is usable', () => {
    const coin = resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: '0.00091234' });
    expect(coin.toFixed(8)).not.toBe('100.00000000');
  });

  it('refuses a missing estimate instead of falling back to USD', () => {
    for (const missing of [null, undefined, '']) {
      expect(() => resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: missing })).toThrow(
        ApiError,
      );
    }
  });

  it('refuses a zero estimate', () => {
    for (const zero of [0, '0', '0.00000000']) {
      expect(() => resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: zero })).toThrow(
        /refused/i,
      );
    }
  });

  it('refuses a negative estimate', () => {
    expect(() =>
      resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: '-0.5' }),
    ).toThrow(/refused/i);
  });

  it('refuses a non-finite estimate (NaN / Infinity)', () => {
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let thrown: unknown = null;
      try {
        resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: broken });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `estimate ${String(broken)} must be refused`).not.toBeNull();
      expect((thrown as ApiError).code).toBe('PAYMENT_ERROR');
    }
  });

  it('surfaces the refusal as an operator-facing PAYMENT_ERROR naming the withdrawal', () => {
    let thrown: unknown = null;
    try {
      resolvePayoutCoinAmount({ ...usdWithdrawal, estimatedAmount: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.code).toBe('PAYMENT_ERROR');
    expect(error.message).toContain(usdWithdrawal.withdrawalId);
    expect(error.message).toContain('100.00');
    expect(error.message.toLowerCase()).toContain('manual');
  });
});

describe('IPN payload discrimination (deposit shape vs payout shape)', () => {
  it('classifies a deposit body by its payment_id', () => {
    expect(
      classifyIpnPayload({ payment_id: '5123456789', payment_status: 'finished', price_amount: 250 }),
    ).toBe('DEPOSIT');
  });

  it('classifies a payout body by its id + withdrawals[]', () => {
    expect(
      classifyIpnPayload({
        id: '987654321',
        withdrawals: [{ id: '1', status: 'finished', unique_external_id: 'wd-1' }],
      }),
    ).toBe('PAYOUT');
  });

  it('never mistakes a payout body for a deposit (it has no payment_id)', () => {
    const payoutIpn = { id: 987654321, withdrawals: [{ id: 1, status: 'finished' }] };
    expect(classifyIpnPayload(payoutIpn)).not.toBe('DEPOSIT');
  });

  it('never mistakes a deposit body for a payout (it has no withdrawals[])', () => {
    expect(
      classifyIpnPayload({ payment_id: '1', payment_status: 'finished' }),
    ).not.toBe('PAYOUT');
  });

  it('marks anything else UNRECOGNISED rather than guessing', () => {
    for (const junk of [null, [], 'text', 42, {}, { id: '1' }, { withdrawals: [] }]) {
      expect(classifyIpnPayload(junk)).toBe('UNRECOGNISED');
    }
  });

  it('parses a payout body into its provider id, status and our external id', () => {
    const parsed = parsePayoutIpnPayload(
      JSON.stringify({
        id: 987654321,
        withdrawals: [{ id: 5, status: 'finished', unique_external_id: 'wd-abc' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.payoutId).toBe('987654321');
    expect(parsed?.status).toBe('finished');
    expect(parsed?.uniqueExternalId).toBe('wd-abc');
  });

  it('returns null for a body that is not a payout shape', () => {
    expect(parsePayoutIpnPayload(JSON.stringify({ payment_id: '1', payment_status: 'finished' }))).toBeNull();
  });

  it('retains an unparsable payout-shaped body verbatim instead of dropping it', () => {
    const parsed = parsePayoutIpnPayload(JSON.stringify({ id: '1', withdrawals: [{ status: 7 }] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.uniqueExternalId).toBeNull();
    expect(parsed?.raw).toMatchObject({ id: '1' });
  });
});

describe('payout status mapping (an unknown status must never settle or free money)', () => {
  it('settles only on finished', () => {
    expect(mapPayoutStatusToPaymentStatus('finished')).toBe('FINISHED');
    expect(mapPayoutStatusToPaymentStatus('FINISHED')).toBe('FINISHED');
  });

  it('treats failed / rejected / returned as a released reservation', () => {
    for (const status of ['failed', 'rejected', 'returned', 'refunded', 'cancelled']) {
      expect(mapPayoutStatusToPaymentStatus(status)).toBe('FAILED');
    }
  });

  it('keeps an in-flight or unknown status in SENDING', () => {
    for (const status of ['waiting', 'processing', 'sending', 'something-new']) {
      expect(mapPayoutStatusToPaymentStatus(status)).toBe('SENDING');
    }
  });

  it('extracts a tx hash from the withdrawal entry when the provider supplies one', () => {
    expect(
      extractPayoutTxHash({ withdrawals: [{ tx_hash: '0xabc' }] }),
    ).toBe('0xabc');
    expect(extractPayoutTxHash({ withdrawals: [{ status: 'finished' }] })).toBeNull();
  });
});

describe('per-day USD payout cap', () => {
  it('is disabled when the cap is 0 or negative (the default)', () => {
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 1_000_000, requestedUsd: 1_000_000, capUsd: 0 })).toBe(false);
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 1_000_000, requestedUsd: 1_000_000, capUsd: -5 })).toBe(false);
  });

  it('allows a day that lands exactly ON the cap (inclusive boundary)', () => {
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 900, requestedUsd: 100, capUsd: 1000 })).toBe(false);
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 0, requestedUsd: 1000, capUsd: 1000 })).toBe(false);
  });

  it('refuses a request that would cross the cap by one cent', () => {
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 900, requestedUsd: 100.01, capUsd: 1000 })).toBe(true);
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: 999.99, requestedUsd: 0.02, capUsd: 1000 })).toBe(true);
  });

  it('compares as Decimal, with no float drift across many small requests', () => {
    // 0.1 added a hundred times is 10.000000000000002 in IEEE-754; Decimal
    // arithmetic must still land exactly on the cap.
    let already = new Decimal(0);
    for (let i = 0; i < 100; i += 1) already = already.plus(new Decimal('0.1'));
    expect(already.toFixed(2)).toBe('10.00');
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: already, requestedUsd: '0.00', capUsd: 10 })).toBe(false);
    expect(exceedsPayoutDailyCap({ alreadyRequestedUsd: already, requestedUsd: '0.01', capUsd: 10 })).toBe(true);
  });
});

describe('payout address allow-list', () => {
  it('imposes no restriction when the list is empty (the default)', () => {
    expect(isPayoutAddressAllowed('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', [])).toBe(true);
  });

  it('matches an allow-listed address case-insensitively', () => {
    expect(
      isPayoutAddressAllowed('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', [
        'tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t',
      ]),
    ).toBe(true);
  });

  it('refuses an address that is not on a non-empty list', () => {
    expect(isPayoutAddressAllowed('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', ['bc1qexample'])).toBe(false);
  });
});

describe('two-person approval for automated payouts', () => {
  const base = { twoPersonRequired: true, actorUserId: 'admin-a', approvedBy: null as string | null };

  it('defaults ON: a first approval waits for a different admin and never broadcasts', () => {
    const decision = decideTwoPersonApproval({ ...base, manualSettlement: false });
    expect(decision.verdict).toBe('AWAIT_SECOND_APPROVER');
    expect(decision.secondApprovedBy).toBeNull();
  });

  it('a DIFFERENT admin releasing the approval proceeds and is recorded as the second actor', () => {
    const decision = decideTwoPersonApproval({
      ...base,
      approvedBy: 'admin-a',
      actorUserId: 'admin-b',
      manualSettlement: false,
    });
    expect(decision.verdict).toBe('PROCEED');
    expect(decision.secondApprovedBy).toBe('admin-b');
  });

  it('the SAME admin may not release their own approval', () => {
    const decision = decideTwoPersonApproval({
      ...base,
      approvedBy: 'admin-a',
      actorUserId: 'admin-a',
      manualSettlement: false,
    });
    expect(decision.verdict).toBe('REFUSED_SAME_ACTOR');
    expect(decision.reason).toBeTruthy();
  });

  it('manual settlement is exempt even for the approver (no permanent lockout)', () => {
    const decision = decideTwoPersonApproval({
      ...base,
      approvedBy: 'admin-a',
      actorUserId: 'admin-a',
      manualSettlement: true,
    });
    expect(decision.verdict).toBe('MANUAL_SETTLEMENT_EXEMPT');
  });

  it('when the rule is turned off, one admin proceeds (documented single-operator mode)', () => {
    const decision = decideTwoPersonApproval({
      twoPersonRequired: false,
      actorUserId: 'admin-a',
      approvedBy: 'admin-a',
      manualSettlement: false,
    });
    expect(decision.verdict).toBe('PROCEED');
    expect(decision.secondApprovedBy).toBeNull();
  });
});
