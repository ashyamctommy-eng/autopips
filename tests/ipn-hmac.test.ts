import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import './helpers/test-env';
import { serverEnv } from '@/lib/env';
import {
  PROVIDER_STATUS_MAP,
  canonicalizeForSignature,
  isCreditedStatus,
  mapProviderStatusToPaymentStatus,
  sortKeysDeep,
  verifyIpnSignature,
} from '@/server/modules/payments/ipn.service';
import { CREDITED_PAYMENT_STATUSES } from '@/server/accounting/equity';

/**
 * IPN HMAC SUITE — the only authentication on the deposit webhook.
 *
 * The signature must be:
 *   HMAC-SHA512( JSON.stringify(recursively key-sorted payload), NOWPAYMENTS_IPN_SECRET )
 *   hex, compared in constant time against the `x-nowpayments-sig` header.
 *
 * The expected digests here are produced by an INDEPENDENT implementation
 * (`node:crypto` + this file's own `stableStringify`) rather than by calling
 * `canonicalizeForSignature`, so a bug in the module's canonicalisation cannot
 * silently agree with itself. A separate test asserts the two canonical forms
 * are byte-identical.
 */

const secret = serverEnv().NOWPAYMENTS_IPN_SECRET;

/** Independent recursive canonicaliser, written without the module's helpers. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const body = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function independentSignature(body: string, key = secret): string {
  return crypto.createHmac('sha512', key).update(body, 'utf8').digest('hex');
}

function json(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

const ipnBody = {
  payment_id: '5123456789',
  payment_status: 'finished',
  pay_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  price_amount: 250,
  price_currency: 'usd',
  pay_amount: 250.32,
  pay_currency: 'usdttrc20',
  order_id: '3f6d1c1e-6a4a-4a5f-9d3b-2d0a0f1f9d10',
  outcome_amount: 250.32,
  outcome_currency: 'usdttrc20',
  actually_paid: 250.32,
};

/** A body whose keys are deliberately NOT in alphabetical order. */
const reorderedBody = {
  pay_currency: 'usdttrc20',
  payment_status: 'finished',
  payment_id: '5123456789',
  price_amount: 250,
};

describe('canonicalizeForSignature', () => {
  it('sorts keys alphabetically at every nesting level', () => {
    expect(canonicalizeForSignature({ b: 1, a: { d: 4, c: { f: 6, e: 5 } } })).toBe(
      '{"a":{"c":{"e":5,"f":6},"d":4},"b":1}',
    );
  });

  it('preserves array order (order is semantic in an array) but sorts objects inside arrays', () => {
    expect(canonicalizeForSignature({ list: [3, 1, 2], objs: [{ b: 1, a: 2 }, { d: 3, c: 4 }] })).toBe(
      '{"list":[3,1,2],"objs":[{"a":2,"b":1},{"c":4,"d":3}]}',
    );
  });

  it('is byte-identical to the independent implementation (cross-check, not self-agreement)', () => {
    const nested = {
      payment_id: 'x',
      meta: { z: 1, a: { y: [1, { b: true, a: null }], x: 'v' } },
      amount: 12.5,
    };
    expect(canonicalizeForSignature(nested)).toBe(stableStringify(nested));
    expect(canonicalizeForSignature(ipnBody)).toBe(stableStringify(ipnBody));
  });

  it('sortKeysDeep returns primitives untouched and never mutates the input', () => {
    const input = { b: 2, a: 1 };
    const sorted = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(['a', 'b']);
    expect(Object.keys(input)).toEqual(['b', 'a']);
    expect(sortKeysDeep(null)).toBeNull();
    expect(sortKeysDeep('x')).toBe('x');
    expect(sortKeysDeep(7)).toBe(7);
  });
});

describe('verifyIpnSignature: accepts a genuine signature', () => {
  it('accepts a signature computed over the canonical form of the exact body', () => {
    const body = json(ipnBody);
    const signature = independentSignature(stableStringify(ipnBody));
    const result = verifyIpnSignature({ rawBody: body, signatureHeader: signature });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    // The debug digest is surfaced only because NODE_ENV === 'test'.
    expect(result.computedDebug).toBe(signature);
    expect((serverEnv().NODE_ENV as string)).toBe('test');
  });

  it('is key-order independent: a reordered body canonicalises to the same signature', () => {
    const signature = independentSignature(stableStringify(reorderedBody));
    const result = verifyIpnSignature({ rawBody: json(reorderedBody), signatureHeader: signature });
    expect(result.valid).toBe(true);
  });

  it('accepts an upper-case hex signature (providers are inconsistent)', () => {
    const signature = independentSignature(stableStringify(ipnBody)).toUpperCase();
    expect(verifyIpnSignature({ rawBody: json(ipnBody), signatureHeader: signature }).valid).toBe(true);
  });

  it('accepts a signature with surrounding whitespace (header hygiene)', () => {
    const signature = independentSignature(stableStringify(ipnBody));
    expect(verifyIpnSignature({ rawBody: json(ipnBody), signatureHeader: `  ${signature}  ` }).valid).toBe(true);
  });
});

describe('verifyIpnSignature: rejects everything else', () => {
  const goodBody = json(ipnBody);
  const goodSignature = independentSignature(stableStringify(ipnBody));

  it('rejects a body with one field altered (the classic "credit myself" forgery)', () => {
    const forged: Record<string, unknown> = { ...ipnBody, price_amount: 250_000 };
    const result = verifyIpnSignature({ rawBody: json(forged), signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a body with an extra key (smuggling a field past the signer)', () => {
    const forged: Record<string, unknown> = { ...ipnBody, extra: 'injected' };
    const result = verifyIpnSignature({ rawBody: json(forged), signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a body with a key removed', () => {
    const { actually_paid: _dropped, ...forged } = ipnBody;
    void _dropped;
    const result = verifyIpnSignature({ rawBody: json(forged), signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a signature of the wrong length without throwing (timingSafeEqual guard)', () => {
    const result = verifyIpnSignature({ rawBody: goodBody, signatureHeader: goodSignature.slice(0, 32) });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_LENGTH_MISMATCH');
    // Present in test mode so a failing handshake can be debugged.
    expect(result.computedDebug).toBe(goodSignature);
  });

  it('rejects an over-long signature too', () => {
    const result = verifyIpnSignature({ rawBody: goodBody, signatureHeader: `${goodSignature}00` });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_LENGTH_MISMATCH');
  });

  it('rejects a missing header', () => {
    expect(verifyIpnSignature({ rawBody: goodBody, signatureHeader: null }).reason).toBe('MISSING_SIGNATURE_HEADER');
    expect(verifyIpnSignature({ rawBody: goodBody, signatureHeader: '   ' }).reason).toBe('MISSING_SIGNATURE_HEADER');
  });

  it('rejects an empty body', () => {
    const result = verifyIpnSignature({ rawBody: '', signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('EMPTY_BODY');
  });

  it('rejects a non-JSON body', () => {
    const result = verifyIpnSignature({ rawBody: 'not json at all', signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_JSON');
  });

  it('rejects a JSON array body (only an object can be an IPN)', () => {
    const result = verifyIpnSignature({ rawBody: '[1,2,3]', signatureHeader: goodSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('PAYLOAD_NOT_OBJECT');
  });

  it('rejects JSON null and a JSON scalar body', () => {
    expect(verifyIpnSignature({ rawBody: 'null', signatureHeader: goodSignature }).reason).toBe('PAYLOAD_NOT_OBJECT');
    expect(verifyIpnSignature({ rawBody: '"finished"', signatureHeader: goodSignature }).reason).toBe(
      'PAYLOAD_NOT_OBJECT',
    );
  });

  it('rejects a signature computed with the WRONG secret (same length, subtle mismatch)', () => {
    const wrongSignature = independentSignature(stableStringify(ipnBody), `${secret}-wrong`);
    expect(wrongSignature).toHaveLength(goodSignature.length);
    const result = verifyIpnSignature({ rawBody: goodBody, signatureHeader: wrongSignature });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('never throws for any malformed input (a throw would be a 500, not a rejection)', () => {
    const cases: Array<{ rawBody: string; signatureHeader: string | null }> = [
      { rawBody: '', signatureHeader: null },
      { rawBody: '{}', signatureHeader: null },
      { rawBody: '{', signatureHeader: 'x' },
      { rawBody: '[', signatureHeader: 'x'.repeat(128) },
      { rawBody: '{"a":1}', signatureHeader: 'z'.repeat(128) },
    ];
    for (const input of cases) {
      expect(() => verifyIpnSignature(input)).not.toThrow();
      expect(verifyIpnSignature(input).valid).toBe(false);
    }
  });
});

describe('mapProviderStatusToPaymentStatus', () => {
  it('maps confirmed and finished to credited statuses', () => {
    expect(mapProviderStatusToPaymentStatus('confirmed')).toBe('CONFIRMED');
    expect(mapProviderStatusToPaymentStatus('finished')).toBe('FINISHED');
    expect(isCreditedStatus(mapProviderStatusToPaymentStatus('confirmed'))).toBe(true);
    expect(isCreditedStatus(mapProviderStatusToPaymentStatus('finished'))).toBe(true);
  });

  it('maps waiting/confirming/partially_paid/sending to NON-credited statuses', () => {
    const nonCredited: Array<[string, string]> = [
      ['waiting', 'WAITING'],
      ['confirming', 'PENDING'],
      ['partially_paid', 'PENDING'],
      ['sending', 'SENDING'],
    ];
    for (const [provider, mapped] of nonCredited) {
      expect(mapProviderStatusToPaymentStatus(provider)).toBe(mapped);
      expect(isCreditedStatus(mapProviderStatusToPaymentStatus(provider))).toBe(false);
    }
  });

  it('maps failed/refunded/expired to non-credited terminal statuses', () => {
    expect(mapProviderStatusToPaymentStatus('failed')).toBe('FAILED');
    expect(mapProviderStatusToPaymentStatus('refunded')).toBe('REFUNDED');
    expect(mapProviderStatusToPaymentStatus('expired')).toBe('FAILED');
    for (const provider of ['failed', 'refunded', 'expired']) {
      const mapped = mapProviderStatusToPaymentStatus(provider);
      expect(CREDITED_PAYMENT_STATUSES as readonly string[]).not.toContain(mapped);
      expect(isCreditedStatus(mapped)).toBe(false);
    }
  });

  it('is case/whitespace tolerant but unknown statuses degrade to PENDING, never to a credited status', () => {
    expect(mapProviderStatusToPaymentStatus('  FiNiShEd ')).toBe('FINISHED');
    expect(mapProviderStatusToPaymentStatus('something_new')).toBe('PENDING');
    expect(mapProviderStatusToPaymentStatus('')).toBe('PENDING');
    expect(isCreditedStatus(mapProviderStatusToPaymentStatus('something_new'))).toBe(false);
  });

  it('maps exactly nine provider statuses and credits exactly two of them', () => {
    const creditedKeys = Object.entries(PROVIDER_STATUS_MAP)
      .filter(([, mapped]) => isCreditedStatus(mapped))
      .map(([provider]) => provider)
      .sort();
    expect(creditedKeys).toEqual(['confirmed', 'finished']);
    expect(Object.keys(PROVIDER_STATUS_MAP)).toHaveLength(9);
  });
});
