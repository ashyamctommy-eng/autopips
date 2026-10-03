import crypto from 'node:crypto';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { getSetting } from '@/server/modules/settings/settings.service';
import { ApiError } from '@/lib/http';
import { D, type Decimal } from '@/lib/money';
import type { PaymentStatusValue } from '@/types/api';

/**
 * NOWPayments IPN verification (business directive #6) — THE SECURITY-CRITICAL
 * MODULE.
 *
 * The webhook endpoint is unauthenticated by design: the HMAC *is* the auth.
 * If verification here is wrong in the permissive direction, an attacker can
 * POST `{payment_id, payment_status: "finished", price_amount: 250000}` and
 * credit themselves. Therefore:
 *
 *   1. The signature is computed over the **exact** canonical form the provider
 *      signs, from the **raw** request body (never a re-parsed/re-serialised
 *      Next.js `request.json()` result).
 *   2. Comparison uses crypto.timingSafeEqual on equal-length buffers, with the
 *      length guarded *beforehand* (timingSafeEqual throws on a length
 *      mismatch — a throw here would be a 500, and a 500 is not a rejection).
 *   3. Anything unexpected (missing header, malformed JSON, non-object payload,
 *      short/long signature) returns `{ valid: false, reason }`. No path
 *      throws, so the caller always reaches the "reject + audit + do not
 *      mutate" branch.
 *   4. The computed digest is only surfaced as `computedDebug`, and only when
 *      NODE_ENV === 'test', so production logs can never contain a correct
 *      signature for an attacker to replay from the log file.
 */

// ─── canonicalization (pure, unit-testable) ─────────────────────────────────

/**
 * Recursively sort object keys alphabetically. Arrays keep their order (order
 * is semantic in an array) but objects inside them are sorted too.
 *
 * Non-plain objects are returned untouched — the wire payload is JSON, so only
 * plain objects/arrays/primitives appear.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The exact string NOWPayments signs: `JSON.stringify` of the key-sorted
 * payload with no extra whitespace.
 *
 * NOTE on ordering: key insertion order (not alphabetical order) is what
 * JSON.stringify emits, which is precisely why `sortKeysDeep` builds a *new*
 * object with keys inserted in sorted order. Integer-like keys ("0", "10")
 * would be re-ordered numerically by V8's own property ordering — the provider
 * runs the same V8 semantics, so this matches its digest byte-for-byte; the
 * IPN payload's real keys (`payment_id`, `price_amount`, ...) are never
 * integer-like.
 */
export function canonicalizeForSignature(payload: unknown): string {
  return JSON.stringify(sortKeysDeep(payload));
}

// ─── signature verification ─────────────────────────────────────────────────

export interface IpnVerificationResult {
  valid: boolean;
  /** Machine-readable failure code. Never contains key or signature material. */
  reason?: string;
  /** The digest we computed. Present ONLY when NODE_ENV === 'test'. */
  computedDebug?: string;
}

export interface VerifyIpnSignatureInput {
  rawBody: string;
  signatureHeader: string | null;
}

export const IPN_SIGNATURE_HEADER = 'x-nowpayments-sig';

/**
 * HMAC-SHA512(canonicalizeForSignature(body), NOWPAYMENTS_IPN_SECRET) vs the
 * `x-nowpayments-sig` header, constant-time.
 */
export function verifyIpnSignature(input: VerifyIpnSignatureInput): IpnVerificationResult {
  const { rawBody, signatureHeader } = input;

  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { valid: false, reason: 'EMPTY_BODY' };
  }
  if (!signatureHeader || signatureHeader.trim().length === 0) {
    return { valid: false, reason: 'MISSING_SIGNATURE_HEADER' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, reason: 'INVALID_JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'PAYLOAD_NOT_OBJECT' };
  }

  // Admin console → Settings wins, so a rotated IPN secret can be applied
  // without a redeploy. NOTE: keeping this in step with the NOWPayments
  // dashboard is what makes deposits creditable at all.
  const secret = getSetting('nowpayments.ipn_secret') || serverEnv().NOWPAYMENTS_IPN_SECRET;
  const computed = crypto
    .createHmac('sha512', secret)
    .update(canonicalizeForSignature(parsed), 'utf8')
    .digest('hex');

  const provided = signatureHeader.trim().toLowerCase();
  const providedBuf = Buffer.from(provided, 'utf8');
  const computedBuf = Buffer.from(computed, 'utf8');

  // Guard the length first: timingSafeEqual throws (RangeError) on a mismatch,
  // and a throw would become a 500 instead of a clean rejection.
  if (providedBuf.length !== computedBuf.length) {
    const mismatch: IpnVerificationResult = {
      valid: false,
      reason: 'SIGNATURE_LENGTH_MISMATCH',
    };
    if (serverEnv().NODE_ENV === 'test') mismatch.computedDebug = computed;
    return mismatch;
  }

  const matches = crypto.timingSafeEqual(computedBuf, providedBuf);

  const result: IpnVerificationResult = matches
    ? { valid: true }
    : { valid: false, reason: 'SIGNATURE_MISMATCH' };

  // Never expose the expected digest outside a test process.
  if (serverEnv().NODE_ENV === 'test') result.computedDebug = computed;
  return result;
}

// ─── payload parsing ────────────────────────────────────────────────────────

/** Shape of the provider JSON we retain verbatim on the Deposit row. */
export type JsonObject = Record<string, unknown>;

const decimalField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : D(v)));

const optionalString = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));

const ipnSchema = z.object({
  // Required: without these two there is nothing to reconcile.
  payment_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0, { message: 'payment_id must not be empty' }),
  payment_status: z.string().min(1),

  pay_address: optionalString,
  price_amount: decimalField,
  price_currency: optionalString,
  pay_amount: decimalField,
  pay_currency: optionalString,
  order_id: optionalString,
  purchase_id: optionalString,
  outcome_amount: decimalField,
  outcome_currency: optionalString,
  actually_paid: decimalField,
});

export interface IpnPayload {
  paymentId: string;
  paymentStatus: string;
  payAddress: string | null;
  priceAmount: Decimal | null;
  priceCurrency: string | null;
  payAmount: Decimal | null;
  payCurrency: string | null;
  orderId: string | null;
  purchaseId: string | null;
  outcomeAmount: Decimal | null;
  outcomeCurrency: string | null;
  actuallyPaid: Decimal | null;
  /** The provider payload exactly as delivered (for Deposit.ipnPayload). */
  raw: JsonObject;
}

/**
 * zod-validate the IPN body. Throws ApiError.badRequest on a malformed payload
 * — the caller has already verified the HMAC, so a malformed body can only come
 * from the provider or from a compromised IPN secret, both of which must be
 * loud.
 */
export function parseIpnPayload(rawBody: string): IpnPayload {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw ApiError.badRequest('IPN body is not valid JSON.');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw ApiError.badRequest('IPN body must be a JSON object.');
  }

  const parsed = ipnSchema.safeParse(json);
  if (!parsed.success) {
    throw ApiError.badRequest('IPN payload failed validation.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const data = parsed.data;
  return {
    paymentId: data.payment_id,
    paymentStatus: data.payment_status,
    payAddress: data.pay_address,
    priceAmount: data.price_amount,
    priceCurrency: data.price_currency,
    payAmount: data.pay_amount,
    payCurrency: data.pay_currency,
    orderId: data.order_id,
    purchaseId: data.purchase_id,
    outcomeAmount: data.outcome_amount,
    outcomeCurrency: data.outcome_currency,
    actuallyPaid: data.actually_paid,
    raw: json as JsonObject,
  };
}

// ─── IPN shape discrimination (deposit vs payout) ───────────────────────────

/**
 * The provider delivers TWO unrelated webhook bodies to the SAME URL:
 *
 *   deposit  { payment_id, payment_status, pay_amount, price_amount, ... }
 *   payout   { id, withdrawals: [{ id, status, unique_external_id, ... }] }
 *
 * `payment_id` is REQUIRED for a deposit and never present on a payout, and
 * `withdrawals[]` is what makes a body a payout. Discriminating on SHAPE (not
 * on a header, not on a path) is the only reliable test: the payout body does
 * not carry a `payment_id`, so the deposit parser would reject it with a 400,
 * and a 400 makes the provider retry the same undeliverable body forever.
 */
export type IpnKind = 'DEPOSIT' | 'PAYOUT' | 'UNRECOGNISED';

export function classifyIpnPayload(json: unknown): IpnKind {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return 'UNRECOGNISED';
  const body = json as Record<string, unknown>;

  // Payout first: it is the shape with the extra, unambiguous marker.
  const hasPayoutId = typeof body.id === 'string' || typeof body.id === 'number';
  if (hasPayoutId && Array.isArray(body.withdrawals)) return 'PAYOUT';

  const hasPaymentId = typeof body.payment_id === 'string' || typeof body.payment_id === 'number';
  if (hasPaymentId) return 'DEPOSIT';

  return 'UNRECOGNISED';
}

/**
 * Wire shape of a payout IPN. Mirrors the payout payload modelled in
 * nowpayments.client.ts (the same shape POST /payout answers with); it is
 * declared here so the IPN module stays free of the HTTP client's Redis/env
 * dependency. Every field is optional except the `withdrawals` array that made
 * this body a payout in the first place.
 */
const payoutIpnSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  withdrawals: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).nullish(),
      status: z.string().nullish(),
      unique_external_id: z.union([z.string(), z.number()]).nullish(),
    }),
  ),
});

export interface PayoutIpnPayload {
  /** The provider's payout id, when the body carries one. */
  payoutId: string | null;
  /** The provider's status for this withdrawal (e.g. finished, failed). */
  status: string | null;
  /** Our idempotency key — the withdrawal id we sent to the provider. */
  uniqueExternalId: string | null;
  /** The provider payload exactly as delivered (for Withdrawal.ipnPayload). */
  raw: JsonObject;
}

/**
 * Parse a body already classified as PAYOUT. Returns null when the body is not
 * a payout shape at all. When the shape LOOKS like a payout but does not
 * validate, the raw body is still returned with null fields, so the caller can
 * record the evidence and acknowledge it rather than let the provider retry a
 * body we will never be able to parse.
 */
export function parsePayoutIpnPayload(rawBody: string): PayoutIpnPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (classifyIpnPayload(json) !== 'PAYOUT') return null;

  const parsed = payoutIpnSchema.safeParse(json);
  if (!parsed.success) {
    return { payoutId: null, status: null, uniqueExternalId: null, raw: json as JsonObject };
  }

  const withdrawal = parsed.data.withdrawals[0];
  const id = parsed.data.id ?? withdrawal?.id ?? null;
  const external =
    withdrawal?.unique_external_id === null || withdrawal?.unique_external_id === undefined
      ? null
      : String(withdrawal.unique_external_id).trim();

  return {
    payoutId: id === null || id === undefined ? null : String(id),
    status: withdrawal?.status?.trim() || null,
    uniqueExternalId: external && external.length > 0 ? external : null,
    raw: json as JsonObject,
  };
}

// ─── status mapping ─────────────────────────────────────────────────────────

/**
 * NOWPayments payment statuses:
 *   waiting, confirming, confirmed, sending, partially_paid, finished, failed,
 *   refunded, expired
 *
 * Non-credited by construction: `partially_paid` (the client under-paid — a
 * human must decide) and `expired` (the address timed out) map to PENDING and
 * FAILED respectively; neither is in CREDITED_PAYMENT_STATUSES, so neither can
 * ever raise the client's equity.
 */
export const PROVIDER_STATUS_MAP: Record<string, PaymentStatusValue> = {
  waiting: 'WAITING',
  confirming: 'PENDING',
  confirmed: 'CONFIRMED',
  sending: 'SENDING',
  partially_paid: 'PENDING',
  finished: 'FINISHED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'FAILED',
};

/** Unknown provider statuses degrade to PENDING (visible, non-credited) — never
 *  to a credited status. */
export function mapProviderStatusToPaymentStatus(providerStatus: string): PaymentStatusValue {
  const key = providerStatus.trim().toLowerCase();
  return PROVIDER_STATUS_MAP[key] ?? 'PENDING';
}

/** True only for statuses that represent money actually received. */
export function isCreditedStatus(status: PaymentStatusValue): boolean {
  return status === 'CONFIRMED' || status === 'FINISHED';
}

/** Ordering used to refuse a late non-credited IPN from un-crediting a
 *  confirmed deposit (money that arrived stays arrived). */
export function isTerminalFailureStatus(status: PaymentStatusValue): boolean {
  return status === 'FAILED' || status === 'REFUNDED';
}

// ─── payout status mapping ───────────────────────────────────────────────────

/**
 * NOWPayments payout statuses, mapped onto the SAME frozen PaymentStatus enum.
 *
 *   finished                          → FINISHED  (money left the treasury)
 *   failed / rejected / returned /
 *   refunded / cancelled              → FAILED    (money did NOT leave; the
 *                                                 reservation is released)
 *   waiting / processing / sending    → SENDING   (still in flight)
 *   anything unknown                  → SENDING, deliberately
 *
 * The default is SENDING, never FINISHED and never FAILED: an unrecognised
 * status must not silently settle a payout (that would debit the client for
 * money that may not have moved) and must not silently free the reservation
 * (that would let the client request the same money twice while a payout may
 * still be in flight). An operator reconciles the unknown case from
 * Withdrawal.providerStatus/ipnPayload.
 */
export const PAYOUT_STATUS_MAP: Record<string, PaymentStatusValue> = {
  finished: 'FINISHED',
  failed: 'FAILED',
  rejected: 'FAILED',
  returned: 'FAILED',
  refunded: 'FAILED',
  cancelled: 'FAILED',
  canceled: 'FAILED',
  waiting: 'SENDING',
  processing: 'SENDING',
  sending: 'SENDING',
  pending: 'SENDING',
};

export function mapPayoutStatusToPaymentStatus(providerStatus: string): PaymentStatusValue {
  const key = providerStatus.trim().toLowerCase();
  return PAYOUT_STATUS_MAP[key] ?? 'SENDING';
}

/**
 * Pull a chain transaction hash out of a payout IPN, if the provider supplied
 * one. NOWPayments' documented payout body carries only id/status/
 * unique_external_id, so the hash is optional by nature: it is recorded when
 * present and left alone when absent — never invented.
 */
export function extractPayoutTxHash(raw: JsonObject): string | null {
  const withdrawal = Array.isArray(raw.withdrawals)
    ? (raw.withdrawals[0] as Record<string, unknown> | undefined)
    : undefined;
  const candidates = ['tx_hash', 'txHash', 'hash', 'transaction_hash', 'transactionHash'];

  for (const source of [withdrawal, raw]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of candidates) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}
