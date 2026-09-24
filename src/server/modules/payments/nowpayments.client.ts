import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { getSetting } from '@/server/modules/settings/settings.service';
import { ApiError } from '@/lib/http';
import { redis, rkey } from '@/lib/redis';
import { D, type Decimal } from '@/lib/money';

/**
 * NOWPayments.io REST client (business directive #6).
 *
 * Thin wrapper over https://api.nowpayments.io/v1. Every request:
 *   - carries `x-api-key: NOWPAYMENTS_API_KEY` (read from serverEnv() only),
 *   - sends `Content-Type: application/json`,
 *   - is aborted after 15s (AbortController) so a hung provider cannot pin a
 *     Next.js request or a settlement worker,
 *   - maps any non-2xx body to ApiError.paymentError carrying the provider's
 *     own message.
 *
 * THE API KEY IS NEVER LOGGED OR ECHOED. Provider error bodies are scrubbed
 * against the key before they are attached to an error, and the key is never
 * placed in a returned value.
 *
 * ZERO SIMULATION: this client returns provider responses verbatim (validated
 * by zod). It never fabricates a payment id, an address, or a status.
 *
 * ─── PAYOUTS ────────────────────────────────────────────────────────────────
 * The NOWPayments **payout** API (`POST /v1/payout`) is NOT authenticated with a
 * static API key. It requires a short-lived JWT obtained from `POST /v1/auth`
 * with an email + password pair (the "custodial payout" flow). That credential
 * MUST be supplied out-of-band by the deployment and is deliberately NOT part
 * of the shared env schema in src/lib/env.ts:
 *
 *     NOWPAYMENTS_PAYOUT_JWT        (pre-minted JWT, rotated by the operator)
 *   or
 *     NOWPAYMENTS_PAYOUT_EMAIL + NOWPAYMENTS_PAYOUT_PASSWORD  (mint via /auth)
 *
 * `requestPayoutJwt()` performs the /auth exchange for the second form.
 * When neither credential is present `isPayoutConfigured()` is false and
 * `createPayout()` throws ApiError.paymentError telling the caller that manual
 * settlement is required. It never returns a fabricated success — a withdrawal
 * that cannot be broadcast stays APPROVED and is settled by an operator, who
 * records the txHash manually.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const CURRENCIES_CACHE_KEY = rkey('nowpayments', 'currencies', 'v1');
const CURRENCIES_CACHE_TTL_SECONDS = 60 * 60; // 1 hour, per directive #6

/** Out-of-band payout credentials — intentionally outside the env schema. */
const PAYOUT_JWT_ENV = 'NOWPAYMENTS_PAYOUT_JWT';
const PAYOUT_EMAIL_ENV = 'NOWPAYMENTS_PAYOUT_EMAIL';
const PAYOUT_PASSWORD_ENV = 'NOWPAYMENTS_PAYOUT_PASSWORD';

export const PAYOUT_NOT_CONFIGURED_MESSAGE =
  'NOWPayments payout API is not configured on this deployment (no payout JWT or payout credentials). ' +
  'Manual settlement is required: approve the withdrawal, pay it from the treasury wallet, then record the txHash.';

// ─── wire schemas ────────────────────────────────────────────────────────────

const idLike = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => v.length > 0, { message: 'empty provider id' });

const decimalLike = z.union([z.string(), z.number()]).transform((v) => D(v));

const paymentCreateSchema = z.object({
  payment_id: idLike,
  payment_status: z.string().min(1),
  pay_address: z.string().min(1),
  pay_amount: decimalLike,
  price_amount: decimalLike,
  price_currency: z.string().optional(),
  pay_currency: z.string().optional(),
  order_id: z.union([z.string(), z.number()]).nullish(),
  order_description: z.string().nullish(),
  ipn_callback_url: z.string().nullish(),
});

const paymentStatusSchema = z.object({
  payment_id: idLike,
  payment_status: z.string().min(1),
  pay_address: z.string().nullish(),
  pay_amount: decimalLike.nullish(),
  price_amount: decimalLike.nullish(),
  price_currency: z.string().nullish(),
  pay_currency: z.string().nullish(),
  order_id: z.union([z.string(), z.number()]).nullish(),
  actually_paid: decimalLike.nullish(),
});

const estimateSchema = z.object({
  currency_from: z.string(),
  amount_from: decimalLike.nullish(),
  currency_to: z.string(),
  estimated_amount: decimalLike.nullish(),
});

const minAmountSchema = z.object({
  currency_from: z.string().optional(),
  currency_to: z.string().optional(),
  min_amount: decimalLike,
  fiat_equivalent: decimalLike.nullish(),
});

const currenciesSchema = z.union([
  z.object({ currencies: z.array(z.string()) }),
  z.array(z.string()),
]);

const authSchema = z.object({ token: z.string().min(1) });

const payoutSchema = z.object({
  id: idLike.nullish(),
  withdrawals: z
    .array(
      z.object({
        id: idLike.nullish(),
        status: z.string().nullish(),
        unique_external_id: z.union([z.string(), z.number()]).nullish(),
      }),
    )
    .nullish(),
});

// ─── public result types ─────────────────────────────────────────────────────

export interface NowPaymentsPayment {
  paymentId: string;
  paymentStatus: string;
  payAddress: string;
  payAmount: Decimal;
  priceAmount: Decimal;
  priceCurrency: string | null;
  payCurrency: string | null;
  orderId: string | null;
  orderDescription: string | null;
}

export interface NowPaymentsPaymentStatus {
  paymentId: string;
  paymentStatus: string;
  payAddress: string | null;
  payAmount: Decimal | null;
  priceAmount: Decimal | null;
  priceCurrency: string | null;
  payCurrency: string | null;
  orderId: string | null;
  actuallyPaid: Decimal | null;
}

export interface NowPaymentsEstimate {
  currencyFrom: string;
  currencyTo: string;
  amountFrom: Decimal | null;
  estimatedAmount: Decimal | null;
}

export interface NowPaymentsMinAmount {
  currencyFrom: string;
  currencyTo: string;
  minAmount: Decimal;
  fiatEquivalent: Decimal | null;
}

export interface NowPaymentsPayoutResult {
  payoutId: string | null;
  status: string | null;
  uniqueExternalId: string | null;
}

export interface CreatePaymentInput {
  priceAmountUsd: Decimal | string | number;
  payCurrency: string;
  /** Our internal order id — reused verbatim on any reconciliation attempt. */
  orderId: string;
  ipnCallbackUrl: string;
  description: string;
}

export interface CreatePayoutInput {
  address: string;
  amount: Decimal | string | number;
  currency: string;
  ipnCallbackUrl: string;
  /** Idempotency key: a retried payout with the same value cannot double-pay. */
  uniqueExternalId: string;
}

// ─── internals ───────────────────────────────────────────────────────────────

/** Distinguishes "the network failed" (safe to retry for idempotent calls)
 *  from "the provider answered with an error" (never retried blindly). */
class NetworkFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkFailure';
  }
}

const NOWPAYMENTS_KEY_ENV_NAME = 'NOWPAYMENTS_API_KEY';

/** Replace the API key (and any credential) with a fixed marker before it can
 *  reach a log line, an audit row, or an API response. */
function scrub(input: string): string {
  const secrets = [
    process.env[NOWPAYMENTS_KEY_ENV_NAME],
    process.env[PAYOUT_JWT_ENV],
    process.env[PAYOUT_PASSWORD_ENV],
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  let out = input;
  for (const secret of secrets) {
    out = out.split(secret).join('***');
  }
  return out;
}

function apiKey(): string {
  // Admin console → Settings wins; serverEnv() is the fallback and still fails
  // fast at boot when neither a console row nor the env var is present.
  return getSetting('nowpayments.api_key') || serverEnv().NOWPAYMENTS_API_KEY;
}

function apiBase(): string {
  return getSetting('nowpayments.api_base').replace(/\/+$/, '');
}

type QueryValue = string | number | boolean | undefined;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${apiBase()}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

interface RequestInput {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
  /** 'api-key' (default) or 'bearer' for the JWT-authenticated payout flow. */
  auth?: { kind: 'api-key' } | { kind: 'bearer'; token: string };
  /**
   * Retry once on a *network* error. Only ever true for calls that are safe to
   * replay: GETs and payouts carrying a unique_external_id idempotency key.
   */
  retryOnNetworkError: boolean;
}

async function requestJson(input: RequestInput): Promise<unknown> {
  const attempts = input.retryOnNetworkError ? 2 : 1;
  let lastFailure: NetworkFailure | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await executeRequest(input);
    } catch (err) {
      if (err instanceof NetworkFailure) {
        lastFailure = err;
        continue;
      }
      throw err;
    }
  }

  throw new ApiError(
    'PAYMENT_ERROR',
    `${input.method} ${input.path} failed after ${attempts} attempt(s): ${scrub(
      lastFailure?.message ?? 'network error',
    )}`,
    502,
    { path: input.path, attempts },
  );
}

async function executeRequest(input: RequestInput): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (input.auth?.kind === 'bearer') {
    headers.Authorization = `Bearer ${input.auth.token}`;
  } else {
    headers['x-api-key'] = apiKey();
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(input.path, input.query), {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // Abort (timeout) or transport failure — no response was received, so the
    // caller must decide whether replaying is safe.
    const reason = err instanceof Error ? err.message : 'unknown transport error';
    throw new NetworkFailure(`${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const providerMessage =
      parsed !== null && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : text.slice(0, 300) || response.statusText;
    throw new ApiError(
      'PAYMENT_ERROR',
      `NOWPayments ${input.path} returned ${response.status}: ${scrub(providerMessage)}`,
      502,
      { status: response.status, path: input.path },
    );
  }

  return parsed;
}

// ─── api-key endpoints ───────────────────────────────────────────────────────

/**
 * POST /payment — create a hosted crypto payment (deposit address + expected
 * amount). NOT retried on a network error: a blind replay would ask the
 * provider to mint a second payment id for the same order. The caller must
 * instead reuse the same `orderId` and reconcile by re-reading the payment
 * status (the provider's IPN for that order id is authoritative).
 */
export async function createPayment(input: CreatePaymentInput): Promise<NowPaymentsPayment> {
  const raw = await requestJson({
    method: 'POST',
    path: '/payment',
    body: {
      price_amount: D(input.priceAmountUsd).toFixed(2),
      price_currency: 'usd',
      pay_currency: input.payCurrency,
      order_id: input.orderId,
      order_description: input.description,
      ipn_callback_url: input.ipnCallbackUrl,
    },
    auth: { kind: 'api-key' },
    retryOnNetworkError: false,
  });

  const payment = paymentCreateSchema.parse(raw);
  return {
    paymentId: payment.payment_id,
    paymentStatus: payment.payment_status,
    payAddress: payment.pay_address,
    payAmount: payment.pay_amount,
    priceAmount: payment.price_amount,
    priceCurrency: payment.price_currency ?? 'usd',
    payCurrency: payment.pay_currency ?? input.payCurrency,
    orderId: payment.order_id === null || payment.order_id === undefined ? null : String(payment.order_id),
    orderDescription: payment.order_description ?? null,
  };
}

/** GET /payment/{payment_id} — authoritative status read, used to reconcile a
 *  PENDING deposit and to recover from an ambiguous POST /payment outcome. */
export async function getPaymentStatus(paymentId: string): Promise<NowPaymentsPaymentStatus> {
  const raw = await requestJson({
    method: 'GET',
    path: `/payment/${encodeURIComponent(paymentId)}`,
    auth: { kind: 'api-key' },
    retryOnNetworkError: true,
  });

  const payment = paymentStatusSchema.parse(raw);
  return {
    paymentId: payment.payment_id,
    paymentStatus: payment.payment_status,
    payAddress: payment.pay_address ?? null,
    payAmount: payment.pay_amount ?? null,
    priceAmount: payment.price_amount ?? null,
    priceCurrency: payment.price_currency ?? null,
    payCurrency: payment.pay_currency ?? null,
    orderId: payment.order_id === null || payment.order_id === undefined ? null : String(payment.order_id),
    actuallyPaid: payment.actually_paid ?? null,
  };
}

/** GET /estimate — indicative conversion of an amount between two currencies. */
export async function getEstimatedPrice(
  amountUsd: Decimal | string | number,
  currencyTo: string,
  currencyFrom = 'usd',
): Promise<NowPaymentsEstimate> {
  const raw = await requestJson({
    method: 'GET',
    path: '/estimate',
    query: {
      amount: D(amountUsd).toFixed(2),
      currency_from: currencyFrom,
      currency_to: currencyTo,
    },
    auth: { kind: 'api-key' },
    retryOnNetworkError: true,
  });

  const estimate = estimateSchema.parse(raw);
  return {
    currencyFrom: estimate.currency_from,
    currencyTo: estimate.currency_to,
    amountFrom: estimate.amount_from ?? null,
    estimatedAmount: estimate.estimated_amount ?? null,
  };
}

/**
 * GET /currencies — the provider's advertised coin list, cached in Redis for
 * one hour so a page render cannot hammer the provider (directive #6).
 * A provider failure is surfaced as ApiError.paymentError; the caller
 * (listSupportedCurrencies) degrades to the server-side allow-list.
 */
export async function getAvailableCurrencies(): Promise<string[]> {
  try {
    const cached = await redis.get(CURRENCIES_CACHE_KEY);
    if (cached) {
      const parsedCache = z.array(z.string()).safeParse(JSON.parse(cached));
      if (parsedCache.success && parsedCache.data.length > 0) return parsedCache.data;
    }
  } catch {
    // Cache read failure is non-fatal — fall through to the provider.
  }

  const raw = await requestJson({
    method: 'GET',
    path: '/currencies',
    auth: { kind: 'api-key' },
    retryOnNetworkError: true,
  });

  const currencies = (() => {
    const parsed = currenciesSchema.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.currencies;
    return Array.from(new Set(list.map((c) => c.toLowerCase().trim()))).filter(Boolean).sort();
  })();

  try {
    await redis.set(
      CURRENCIES_CACHE_KEY,
      JSON.stringify(currencies),
      'EX',
      CURRENCIES_CACHE_TTL_SECONDS,
    );
  } catch {
    // A cache write failure must not fail the request.
  }

  return currencies;
}

/** GET /min-amount — provider minimum for a currency pair. */
export async function getMinimumPaymentAmount(
  currencyFrom: string,
  currencyTo: string,
): Promise<NowPaymentsMinAmount> {
  const raw = await requestJson({
    method: 'GET',
    path: '/min-amount',
    query: {
      currency_from: currencyFrom,
      currency_to: currencyTo,
      fiat_equivalent: 'usd',
    },
    auth: { kind: 'api-key' },
    retryOnNetworkError: true,
  });

  const min = minAmountSchema.parse(raw);
  return {
    currencyFrom: min.currency_from ?? currencyFrom,
    currencyTo: min.currency_to ?? currencyTo,
    minAmount: min.min_amount,
    fiatEquivalent: min.fiat_equivalent ?? null,
  };
}

// ─── payout flow (JWT-authenticated) ─────────────────────────────────────────

export function isPayoutConfigured(): boolean {
  const jwt = process.env[PAYOUT_JWT_ENV];
  if (typeof jwt === 'string' && jwt.trim().length > 0) return true;
  const email = process.env[PAYOUT_EMAIL_ENV];
  const password = process.env[PAYOUT_PASSWORD_ENV];
  return (
    typeof email === 'string' &&
    email.trim().length > 0 &&
    typeof password === 'string' &&
    password.trim().length > 0
  );
}

/**
 * POST /auth — exchange the out-of-band payout email + password for a JWT.
 * Returns null when those credentials are absent, so the caller can fall back
 * to an operator-supplied NOWPAYMENTS_PAYOUT_JWT or to manual settlement.
 */
export async function requestPayoutJwt(email?: string, password?: string): Promise<string | null> {
  const user = email ?? process.env[PAYOUT_EMAIL_ENV];
  const pass = password ?? process.env[PAYOUT_PASSWORD_ENV];
  if (!user || !pass) return null;

  const raw = await requestJson({
    method: 'POST',
    path: '/auth',
    body: { email: user, password: pass },
    auth: { kind: 'api-key' },
    retryOnNetworkError: true,
  });

  return authSchema.parse(raw).token;
}

async function payoutJwt(): Promise<string | null> {
  const preset = process.env[PAYOUT_JWT_ENV];
  if (typeof preset === 'string' && preset.trim().length > 0) return preset.trim();
  return requestPayoutJwt();
}

/**
 * POST /payout — broadcast a crypto payout to a client address.
 *
 * THROWS ApiError.paymentError when `isPayoutConfigured()` is false. This is
 * deliberate: the platform must record a withdrawal as APPROVED (awaiting
 * operator settlement) rather than pretend the money left the treasury.
 *
 * Safe to retry once on a network error because `uniqueExternalId` is the
 * provider-side idempotency key — replaying it cannot double-pay.
 */
export async function createPayout(input: CreatePayoutInput): Promise<NowPaymentsPayoutResult> {
  const token = await payoutJwt();
  if (!token) throw ApiError.paymentError(PAYOUT_NOT_CONFIGURED_MESSAGE);

  const raw = await requestJson({
    method: 'POST',
    path: '/payout',
    body: {
      ipn_callback_url: input.ipnCallbackUrl,
      withdrawals: [
        {
          address: input.address,
          currency: input.currency,
          amount: D(input.amount).toFixed(8),
          unique_external_id: input.uniqueExternalId,
        },
      ],
    },
    auth: { kind: 'bearer', token },
    retryOnNetworkError: true,
  });

  const payout = payoutSchema.parse(raw);
  const first = payout.withdrawals?.[0];
  return {
    payoutId: payout.id ?? first?.id ?? null,
    status: first?.status ?? null,
    uniqueExternalId:
      first?.unique_external_id === null || first?.unique_external_id === undefined
        ? null
        : String(first.unique_external_id),
  };
}
