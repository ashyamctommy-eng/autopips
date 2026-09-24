import { randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { serverEnv } from '@/lib/env';
import { resolvedAllowedCurrencies } from '@/server/modules/settings/settings.service';
import { D, toPrismaDecimal, usd, type Decimal, type Numeric } from '@/lib/money';
import { claimOnce } from '@/lib/rate-limit';
import { assetMeta } from '@/lib/contracts';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import {
  DEBITED_PAYMENT_STATUSES,
  getAccountSnapshot,
} from '@/server/accounting/ledger';
import type { DepositDTO, PaymentStatusValue, SessionUser, WithdrawalDTO } from '@/types/api';
import type { Deposit, Withdrawal } from '@prisma/client';
import {
  createPayment,
  createPayout,
  getAvailableCurrencies,
  getMinimumPaymentAmount,
  getPaymentStatus,
  isPayoutConfigured,
} from './nowpayments.client';
import {
  isCreditedStatus,
  mapProviderStatusToPaymentStatus,
  parseIpnPayload,
  verifyIpnSignature,
  type JsonObject,
} from './ipn.service';

/**
 * Payments service (business directive #6).
 *
 * Deposits and withdrawals are the only two places money enters or leaves
 * Autopipsz, so every rule here is deliberately conservative:
 *
 *   - A deposit row is written ONLY after the provider returned a real payment
 *     id + address. If the provider call fails we persist nothing.
 *   - A deposit is credited ONLY from an IPN whose HMAC verified, and the
 *     credited amount can never exceed the amount the client asked for.
 *   - A withdrawal is requested ONLY against a withdrawable balance computed
 *     from verified ledger rows (equity formula, directive #3), and leaves the
 *     platform ONLY through an admin approval recorded in AuditLog.
 *
 * Everything monetary is Decimal; no float ever touches a balance.
 */

// ─── policy constants ───────────────────────────────────────────────────────

export const DEPOSIT_MIN_USD = 50;
export const DEPOSIT_MAX_USD = 250_000;

/**
 * Withdrawal lifecycle ↔ Prisma's PaymentStatus enum.
 *
 * `PaymentStatus` (shared with deposits) has no APPROVED and no REJECTED
 * member, so the withdrawal states are persisted like this:
 *
 *   PENDING  → requested, awaiting admin review
 *   SENDING  → APPROVED: payout broadcast, or awaiting operator settlement
 *              (the approval itself is durably recorded in `approvedBy` +
 *               the WITHDRAWAL_APPROVED audit row)
 *   FINISHED → paid out (txHash recorded; equity formula treats it as a debit)
 *   FAILED   → REJECTED by an admin (the reason lives in the audit log, as the
 *              model has no rejectionReason column)
 */
const WITHDRAWAL_STATUS_PENDING: PaymentStatusValue = 'PENDING';
const WITHDRAWAL_STATUS_APPROVED: PaymentStatusValue = 'SENDING';
const WITHDRAWAL_STATUS_REJECTED: PaymentStatusValue = 'FAILED';

// ─── small guards ───────────────────────────────────────────────────────────

function isStaff(user: Pick<SessionUser, 'role'>): boolean {
  return user.role === 'ADMIN' || user.role === 'TRADING_MANAGER';
}

/**
 * Mirror of `requireVerifiedClient()` in src/server/modules/auth/session.ts,
 * for callers that already hold a SessionUser (services must not re-read
 * cookies themselves). Staff bypass; everyone else needs APPROVED KYC.
 */
function assertVerifiedClient(user: SessionUser): void {
  if (isStaff(user)) return;
  if (user.kycStatus !== 'APPROVED') throw ApiError.kycRequired();
}

/** Finite, 2 decimal places, within [min, max]. Never a float artefact. */
function assertUsdAmount(
  amountUsd: number,
  opts: { min: number; max: number | null; label: string },
): Decimal {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) {
    throw ApiError.badRequest(`${opts.label} must be a finite number.`);
  }
  const amount = D(amountUsd);
  if (amount.decimalPlaces() > 2) {
    throw ApiError.badRequest(`${opts.label} may not have more than 2 decimal places.`);
  }
  if (amount.lessThan(opts.min)) {
    throw ApiError.badRequest(`${opts.label} must be at least $${opts.min}.`);
  }
  if (opts.max !== null && amount.greaterThan(opts.max)) {
    throw ApiError.badRequest(`${opts.label} may not exceed $${opts.max}.`);
  }
  return amount;
}

function assertAllowedCurrency(cryptoCurrency: string): string {
  const currency = cryptoCurrency.trim().toLowerCase();
  const allowed = resolvedAllowedCurrencies();
  if (!allowed.includes(currency)) {
    throw ApiError.badRequest(
      `Unsupported settlement currency "${cryptoCurrency}". Allowed: ${allowed.join(', ')}.`,
    );
  }
  return currency;
}

/**
 * Loose payout-address format check, per network. This is a typo/sanity gate,
 * not a full base58/bech32 checksum validation — the provider is the final
 * authority and an operator reviews every payout.
 */
export function validatePayoutAddress(cryptoCurrency: string, payoutAddress: string): void {
  const currency = cryptoCurrency.trim().toLowerCase();
  const address = payoutAddress.trim();

  if (address.length < 20 || address.length > 128) {
    throw ApiError.badRequest('Payout address length looks wrong.');
  }

  const TRC20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // T… , 34 chars (TRON base58check)
  const EVM = /^0x[0-9a-fA-F]{40}$/; // ERC20 / BEP20
  const BTC_BECH32 = /^bc1[02-9ac-hj-np-z]{11,71}$/; // bech32 / bech32m, lowercase
  const BTC_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const LTC_BECH32 = /^ltc1[02-9ac-hj-np-z]{11,71}$/;
  const LTC_LEGACY = /^[LM3][1-9A-HJ-NP-Za-km-z]{25,34}$/;

  switch (currency) {
    case 'usdttrc20':
    case 'trx':
      if (!TRC20.test(address)) {
        throw ApiError.badRequest(
          'TRC20 payout address must start with "T" and be 34 characters long.',
        );
      }
      return;
    case 'usdterc20':
    case 'usdtbsc':
    case 'usdc':
    case 'bnb':
    case 'eth':
      if (!EVM.test(address)) {
        throw ApiError.badRequest('This network expects a 0x-prefixed 40-hex-character address.');
      }
      return;
    case 'btc':
      if (!BTC_BECH32.test(address) && !BTC_LEGACY.test(address)) {
        throw ApiError.badRequest(
          'BTC payout address must be bech32 (bc1…) or a legacy 1…/3… address.',
        );
      }
      return;
    case 'ltc':
      if (!LTC_BECH32.test(address) && !LTC_LEGACY.test(address)) {
        throw ApiError.badRequest(
          'LTC payout address must be bech32 (ltc1…) or a legacy L…/M… address.',
        );
      }
      return;
    default:
      // Unknown (allow-listed) network: keep the loose alphanumeric gate above.
      if (!/^[A-Za-z0-9:_-]+$/.test(address)) {
        throw ApiError.badRequest('Payout address contains unexpected characters.');
      }
  }
}

// ─── DTO mapping ────────────────────────────────────────────────────────────

function toDepositDTO(row: Deposit): DepositDTO {
  return {
    id: row.id,
    amountUsd: usd(row.amountUsd).toNumber(),
    cryptoCurrency: row.cryptoCurrency,
    paymentId: row.paymentId,
    depositAddress: row.depositAddress,
    payAmount: D(row.payAmount).toNumber(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWithdrawalDTO(row: Withdrawal): WithdrawalDTO {
  return {
    id: row.id,
    amountUsd: usd(row.amountUsd).toNumber(),
    cryptoCurrency: row.cryptoCurrency,
    payoutAddress: row.payoutAddress,
    feeUsd: usd(row.feeUsd).toNumber(),
    status: row.status,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── amount derivation (pure) ───────────────────────────────────────────────

export interface CreditedAmountInput {
  /** What the client originally asked to deposit (our authoritative request). */
  requestedUsd: Numeric;
  providerPriceAmount?: Numeric | null;
  providerPayAmount?: Numeric | null;
  actuallyPaid?: Numeric | null;
}

export interface CreditedAmountResult {
  amountUsd: ReturnType<typeof usd>;
  /** True when the value came from provider data rather than the request. */
  derived: boolean;
  /** True when the RECEIVED value deviates >2% from the request (in either
   *  direction) — flags an underpayment or an overpayment for human review.
   *  The credited amount is still capped; the flag never changes the cap. */
  mismatch: boolean;
}

/**
 * Derive the bookable USD value from a provider payload.
 *
 *   unitUsd  = price_amount / pay_amount      (USD per unit of crypto)
 *   received = actually_paid × unitUsd
 *
 * Hard rule (directive #6): the result is CAPPED at the requested amount, and
 * at the provider's own price_amount when present. A malicious or buggy IPN can
 * therefore never inflate a deposit — the worst it can do is under-credit,
 * which is visible and reconcilable.
 */
export function deriveCreditedAmountUsd(input: CreditedAmountInput): CreditedAmountResult {
  const requested = usd(input.requestedUsd);
  const providerPrice = input.providerPriceAmount === null || input.providerPriceAmount === undefined
    ? null
    : usd(input.providerPriceAmount);

  const ceiling =
    providerPrice !== null && providerPrice.greaterThan(0) && providerPrice.lessThan(requested)
      ? providerPrice
      : requested;

  const payAmount = D(input.providerPayAmount ?? 0);
  const actuallyPaid = D(input.actuallyPaid ?? 0);
  const unitPrice = providerPrice ?? requested;

  if (unitPrice.lessThanOrEqualTo(0) || payAmount.lessThanOrEqualTo(0) || actuallyPaid.lessThanOrEqualTo(0)) {
    return { amountUsd: ceiling, derived: false, mismatch: false };
  }

  const received = usd(actuallyPaid.times(unitPrice).div(payAmount));
  const bookable = received.greaterThan(ceiling) ? ceiling : received;
  const tolerance = requested.times('0.02');

  return {
    amountUsd: bookable,
    derived: true,
    // Measured on the RAW received value, not the capped one, so an
    // overpayment is flagged for review even though we only credit the
    // requested amount.
    mismatch: received.minus(requested).abs().greaterThan(tolerance),
  };
}

// ─── deposits ───────────────────────────────────────────────────────────────

/** Our deposit ids are uuids; used to sanity-check an order_id fallback. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEPOSIT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const PAYMENT_PENDING_STATUSES: PaymentStatusValue[] = ['PENDING', 'WAITING'];

export interface CreateDepositInput {
  user: SessionUser;
  amountUsd: number;
  cryptoCurrency: string;
  ip?: string | null;
}

/**
 * Create a NOWPayments payment and persist the matching Deposit row.
 *
 * Ordering matters: the provider is called FIRST and the row is written only
 * after a payment id + address came back. A failed provider call leaves the
 * database untouched (no orphan PENDING deposit for the client to chase).
 */
export async function createDeposit(input: CreateDepositInput): Promise<DepositDTO> {
  const { user, amountUsd, cryptoCurrency, ip } = input;

  assertVerifiedClient(user);
  const amount = assertUsdAmount(amountUsd, {
    min: DEPOSIT_MIN_USD,
    max: DEPOSIT_MAX_USD,
    label: 'Deposit amount',
  });
  const currency = assertAllowedCurrency(cryptoCurrency);

  // We mint the id up front so it doubles as the provider `order_id`: the IPN
  // can then be matched by order_id even if payment_id lookup ever fails.
  const depositId = randomUUID();
  const env = serverEnv();
  const ipnCallbackUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/api/v1/payments/nowpayments/ipn`;

  let payment;
  try {
    payment = await createPayment({
      priceAmountUsd: amount,
      payCurrency: currency,
      orderId: depositId,
      ipnCallbackUrl,
      description: `Autopipsz deposit ${depositId}`,
    });
  } catch (err) {
    // Payment provider failure: nothing is persisted. The client may retry; a
    // retry creates a NEW payment with a NEW order id, which is why we never
    // blind-retry the POST upstream (see nowpayments.client.ts).
    await recordAudit({
      action: AUDIT.DEPOSIT_FAILED,
      userId: user.id,
      ipAddress: ip ?? null,
      details: {
        stage: 'PROVIDER_CREATE',
        outcome: 'PROVIDER_FAILURE',
        orderId: depositId,
        amountUsd: amount.toNumber(),
        cryptoCurrency: currency,
      },
    });
    throw err instanceof ApiError
      ? err
      : ApiError.paymentError('Could not create the payment with NOWPayments.');
  }

  const created = await prisma.deposit.create({
    data: {
      id: depositId,
      userId: user.id,
      amountUsd: toPrismaDecimal(amount),
      cryptoCurrency: currency,
      paymentId: payment.paymentId,
      depositAddress: payment.payAddress,
      payAmount: toPrismaDecimal(payment.payAmount, 8),
      status: 'PENDING',
    },
  });

  await recordAudit({
    action: AUDIT.DEPOSIT_CREATED,
    userId: user.id,
    ipAddress: ip ?? null,
    details: {
      depositId: created.id,
      paymentId: created.paymentId,
      amountUsd: amount.toNumber(),
      cryptoCurrency: currency,
      providerStatus: payment.paymentStatus,
      payAmount: payment.payAmount.toString(),
    },
  });

  return toDepositDTO(created);
}

export interface ListOptions {
  take?: number;
  cursor?: string;
  /** Admin-only: list across every user. Enforced by the caller's route. */
  allUsers?: boolean;
}

function pageSize(take?: number): number {
  if (!take || !Number.isFinite(take)) return DEPOSIT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(take), MAX_PAGE_SIZE));
}

export async function listDeposits(
  userId: string,
  opts: ListOptions = {},
): Promise<{ items: DepositDTO[]; nextCursor: string | null }> {
  const take = pageSize(opts.take);
  const rows = await prisma.deposit.findMany({
    where: opts.allUsers ? {} : { userId },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toDepositDTO),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getDeposit(
  userId: string,
  id: string,
  opts: { allUsers?: boolean } = {},
): Promise<DepositDTO> {
  const row = await prisma.deposit.findFirst({
    where: { id, ...(opts.allUsers ? {} : { userId }) },
  });
  if (!row) throw ApiError.notFound('Deposit not found.');
  return toDepositDTO(row);
}

/**
 * Poll the provider for a deposit that has not settled yet and reconcile the
 * local row. Used by GET /api/v1/payments/deposits/[id].
 *
 * A deposit whose IPN was lost (provider outage, secret rotation) must still be
 * credited eventually — this is the recovery path. It is idempotent: the amount
 * is assigned from the provider's data, never incremented, and a row that is
 * already credited is left alone.
 */
export async function reconcileDeposit(
  userId: string,
  id: string,
  opts: { allUsers?: boolean } = {},
): Promise<DepositDTO> {
  const row = await prisma.deposit.findFirst({
    where: { id, ...(opts.allUsers ? {} : { userId }) },
  });
  if (!row) throw ApiError.notFound('Deposit not found.');
  if (!PAYMENT_PENDING_STATUSES.includes(row.status)) return toDepositDTO(row);

  let remote;
  try {
    remote = await getPaymentStatus(row.paymentId);
  } catch (err) {
    // A provider outage must not break the client's history view — return the
    // last known state and let the next poll reconcile.
    if (err instanceof ApiError && err.code === 'PAYMENT_ERROR') return toDepositDTO(row);
    throw err;
  }

  const mapped = mapProviderStatusToPaymentStatus(remote.paymentStatus);
  if (mapped === row.status) return toDepositDTO(row);

  const { amountUsd } = deriveCreditedAmountUsd({
    requestedUsd: row.amountUsd,
    providerPriceAmount: remote.priceAmount,
    providerPayAmount: remote.payAmount,
    actuallyPaid: remote.actuallyPaid,
  });

  const credited = isCreditedStatus(mapped);
  const updated = await prisma.deposit.update({
    where: { id: row.id },
    data: {
      status: mapped,
      amountUsd: toPrismaDecimal(credited ? amountUsd : row.amountUsd),
      ipnPayload: {
        source: 'RECONCILE',
        payment_id: remote.paymentId,
        payment_status: remote.paymentStatus,
        pay_amount: remote.payAmount?.toString() ?? null,
        price_amount: remote.priceAmount?.toString() ?? null,
        actually_paid: remote.actuallyPaid?.toString() ?? null,
        order_id: remote.orderId,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await recordAudit({
    action: credited ? AUDIT.DEPOSIT_CONFIRMED : AUDIT.DEPOSIT_IPN_RECEIVED,
    userId: row.userId,
    details: {
      depositId: row.id,
      paymentId: row.paymentId,
      providerStatus: remote.paymentStatus,
      mappedStatus: mapped,
      source: 'RECONCILE_POLL',
      amountUsd: usd(updated.amountUsd).toNumber(),
    },
  });

  return toDepositDTO(updated);
}

// ─── IPN ────────────────────────────────────────────────────────────────────

export interface HandleIpnInput {
  rawBody: string;
  signature: string | null;
  ip?: string | null;
}

export interface HandleIpnResult {
  duplicate: boolean;
  /** False when the payment_id/order_id matches no deposit we own. */
  matched: boolean;
  depositId?: string;
  status?: PaymentStatusValue;
  credited: boolean;
}

/**
 * Process a NOWPayments IPN.
 *
 * Idempotency argument (see also the REPLAY GUARD below):
 *
 *   1. Redis `claimOnce("ipn:<payment_id>:<payment_status>", 86400)` gives each
 *      (payment, status) pair exactly one processing slot per 24h. NOWPayments
 *      retries deliveries; a retry — and any replay by an attacker who captured
 *      a legitimate body — hits the guard and returns `{duplicate:true}` before
 *      any row is touched.
 *   2. The credited value is ASSIGNED, never incremented: amountUsd :=
 *      min(received, requested), so even a hypothetical double-process cannot
 *      accumulate. Crediting the same deposit twice in a row is idempotent by
 *      arithmetic, not just by the lock.
 *   3. Only CONFIRMED/FINISHED credit equity, and `confirmed` is followed by
 *      `finished` for the same payment — neither transition adds anything,
 *      because (2) holds.
 *   4. claimOnce fails CLOSED: if Redis is unreachable it returns false, which
 *      we treat as "already processed". A dropped IPN is recoverable (provider
 *      retry, or the reconcile poll above); a double credit is not.
 */
export async function handleIpn(input: HandleIpnInput): Promise<HandleIpnResult> {
  const { rawBody, signature, ip } = input;

  // (a) VERIFY FIRST. Nothing is read or written before the HMAC passes.
  const verification = verifyIpnSignature({ rawBody, signatureHeader: signature });
  if (!verification.valid) {
    // recordAuditSafe: a database blip during an attack must not turn a clean
    // 401 into a 500 (the rate limiter, not the DB, is what throttles a flood).
    await recordAuditSafe({
      action: AUDIT.DEPOSIT_IPN_REJECTED,
      details: { reason: verification.reason ?? 'UNKNOWN', ipAddress: ip ?? null },
      ipAddress: ip ?? null,
    });
    throw ApiError.unauthorized('Invalid IPN signature.');
  }

  // (b) parse + locate
  const payload = parseIpnPayload(rawBody);
  const deposit =
    (await prisma.deposit.findUnique({ where: { paymentId: payload.paymentId } })) ??
    (payload.orderId && UUID_RE.test(payload.orderId)
      ? await prisma.deposit.findUnique({ where: { id: payload.orderId } })
      : null);

  const mapped = mapProviderStatusToPaymentStatus(payload.paymentStatus);

  if (!deposit) {
    // Valid signature, unknown payment. Nothing to mutate; record it loudly and
    // ACK so the provider does not retry forever.
    await recordAudit({
      action: AUDIT.DEPOSIT_IPN_RECEIVED,
      details: {
        unmatched: true,
        paymentId: payload.paymentId,
        orderId: payload.orderId,
        providerStatus: payload.paymentStatus,
        mappedStatus: mapped,
        ip: ip ?? null,
      },
      ipAddress: ip ?? null,
    });
    return { duplicate: false, matched: false, status: mapped, credited: false };
  }

  // (c) REPLAY GUARD — the single-use slot for this (payment, status).
  const claimed = await claimOnce(`ipn:${payload.paymentId}:${payload.paymentStatus}`, 86_400);
  if (!claimed) {
    return {
      duplicate: true,
      matched: true,
      depositId: deposit.id,
      status: deposit.status,
      credited: false,
    };
  }

  const alreadyCredited = isCreditedStatus(deposit.status);
  const mappedIsCredited = isCreditedStatus(mapped);

  // Monotonicity: money that arrived stays arrived. A late non-credited status
  // (e.g. `expired` after a manual overpayment was confirmed) never un-credits
  // a deposit — that would silently rebalance the client's equity.
  const regressionBlocked = alreadyCredited && !mappedIsCredited;
  const nextStatus: PaymentStatusValue = regressionBlocked ? deposit.status : mapped;

  const { amountUsd, derived, mismatch } = deriveCreditedAmountUsd({
    requestedUsd: deposit.amountUsd,
    providerPriceAmount: payload.priceAmount,
    providerPayAmount: payload.payAmount,
    actuallyPaid: payload.actuallyPaid,
  });

  // (d) update the row.
  //
  // `amountUsd` is the ORIGINAL requested amount and doubles as the ceiling for
  // any later credit — so a NON-credited status must leave it alone. An earlier
  // version rewrote it down to the actually-received figure on
  // `partially_paid`, which permanently capped the ceiling: a subsequent
  // `finished` carrying the full payment was then credited only at the partial
  // amount (verified: $100 requested, $10 partial, then full payment →
  // credited $10, a $90 under-credit). The partial figure is fully recorded in
  // `ipnPayload` below, so nothing is lost by not overwriting the column.
  //
  // For a CREDITED status the value is derived from verified provider data and
  // capped at the requested amount, so a replayed or forged high figure can
  // never inflate the balance.
  const bookable = mappedIsCredited ? amountUsd : usd(deposit.amountUsd);

  const updated = await prisma.deposit.update({
    where: { id: deposit.id },
    data: {
      status: nextStatus,
      amountUsd: toPrismaDecimal(bookable),
      ipnPayload: payload.raw as unknown as Prisma.InputJsonValue,
    },
  });

  // (e) audit
  await recordAudit({
    action: AUDIT.DEPOSIT_IPN_RECEIVED,
    userId: deposit.userId,
    ipAddress: ip ?? null,
    details: {
      level: 'info',
      depositId: deposit.id,
      paymentId: payload.paymentId,
      providerStatus: payload.paymentStatus,
      mappedStatus: mapped,
      appliedStatus: nextStatus,
      regressionBlocked,
      actuallyPaid: payload.actuallyPaid?.toString() ?? null,
      payAmount: payload.payAmount?.toString() ?? null,
      amountUsd: usd(updated.amountUsd).toNumber(),
      derived,
      amountMismatch: mismatch,
      ip: ip ?? null,
    },
  });

  if (mappedIsCredited && !alreadyCredited && !regressionBlocked) {
    await recordAudit({
      action: AUDIT.DEPOSIT_CONFIRMED,
      userId: deposit.userId,
      ipAddress: ip ?? null,
      details: {
        depositId: deposit.id,
        paymentId: payload.paymentId,
        status: nextStatus,
        creditedUsd: usd(updated.amountUsd).toNumber(),
        amountMismatch: mismatch,
      },
    });
  }

  if (!regressionBlocked && (nextStatus === 'FAILED' || nextStatus === 'REFUNDED')) {
    await recordAudit({
      action: AUDIT.DEPOSIT_FAILED,
      userId: deposit.userId,
      ipAddress: ip ?? null,
      details: {
        depositId: deposit.id,
        paymentId: payload.paymentId,
        status: nextStatus,
        providerStatus: payload.paymentStatus,
      },
    });
  }

  return {
    duplicate: false,
    matched: true,
    depositId: updated.id,
    status: updated.status,
    credited: mappedIsCredited && !alreadyCredited && !regressionBlocked,
  };
}

/**
 * For a non-credited status we only lower `amountUsd` when the provider
 * confirms a partial payment (honest record of what actually arrived). The row
 * is not credited, so equity is unaffected either way.
 */
// ─── account snapshot ───────────────────────────────────────────────────────

/**
 * Withdrawal eligibility comes from the SAME ledger the client dashboard reads.
 *
 * This deliberately delegates to `getAccountSnapshot` in
 * src/server/accounting/ledger.ts instead of aggregating locally. An earlier
 * version kept a private copy of the equity formula here, and it drifted: it
 * treated only ACTIVE investments as locked (so PAUSED capital looked
 * withdrawable) and omitted the ledger's capital partition, which let a client
 * request a payout against money that was already deployed.
 *
 * One formula, one implementation. Do not re-derive it here.
 */

// ─── withdrawals ────────────────────────────────────────────────────────────

export interface RequestWithdrawalInput {
  user: SessionUser;
  amountUsd: number;
  cryptoCurrency: string;
  payoutAddress: string;
  ip?: string | null;
}

export async function requestWithdrawal(input: RequestWithdrawalInput): Promise<WithdrawalDTO> {
  const { user, amountUsd, cryptoCurrency, payoutAddress, ip } = input;

  assertVerifiedClient(user);
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw ApiError.badRequest('Withdrawal amount must be a positive number.');
  }
  // No artificial maximum: the withdrawable-balance check below is the real
  // ceiling, and it is derived from verified ledger rows.
  const amount = assertUsdAmount(amountUsd, {
    min: 0.01,
    max: null,
    label: 'Withdrawal amount',
  });
  const currency = assertAllowedCurrency(cryptoCurrency);
  validatePayoutAddress(currency, payoutAddress);

  // ── Atomic eligibility check + reservation ────────────────────────────────
  // This MUST be one transaction with the user row locked. A plain
  // read-then-write is a time-of-check/time-of-use race: three concurrent
  // requests each read the same `withdrawableBalance` and each succeed, so a
  // 600 balance can reserve 1800. Reservations are what admins approve, so the
  // race is an over-payout, not just a display bug. Verified against the live
  // database before this lock was added.
  //
  // `SELECT ... FOR UPDATE` on the User row serialises every money-moving
  // operation for this user (withdrawals AND investments take the same lock),
  // while different users still proceed in parallel.
  const { created, snapshot } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

    const locked = await getAccountSnapshot(user.id, tx);
    if (amount.greaterThan(locked.withdrawableBalance)) {
      throw ApiError.insufficientFunds(
        `Withdrawable balance is $${locked.withdrawableBalance.toFixed(2)}; requested $${amount.toFixed(2)}. ` +
          'Capital deployed in active strategies is not withdrawable until it is released.',
      );
    }

    const row = await tx.withdrawal.create({
      data: {
        userId: user.id,
        amountUsd: toPrismaDecimal(amount),
        cryptoCurrency: currency,
        payoutAddress: payoutAddress.trim(),
        // Fee is not charged today. The column is written honestly as 0.00 so a
        // future fee schedule cannot look retroactively applied.
        feeUsd: toPrismaDecimal(0),
        status: WITHDRAWAL_STATUS_PENDING,
      },
    });

    return { created: row, snapshot: locked };
  });

  await recordAudit({
    action: AUDIT.WITHDRAWAL_REQUESTED,
    userId: user.id,
    ipAddress: ip ?? null,
    details: {
      withdrawalId: created.id,
      amountUsd: amount.toNumber(),
      cryptoCurrency: currency,
      feeUsd: 0,
      equityUsd: snapshot.breakdown.equity.toNumber(),
      activeCapitalUsd: snapshot.activeCapital.toNumber(),
      pendingWithdrawalsUsd: snapshot.pendingWithdrawals.toNumber(),
      withdrawableUsd: snapshot.withdrawableBalance.toNumber(),
    },
  });

  return toWithdrawalDTO(created);
}

export async function listWithdrawals(
  userId: string,
  opts: ListOptions = {},
): Promise<{ items: WithdrawalDTO[]; nextCursor: string | null }> {
  const take = pageSize(opts.take);
  const rows = await prisma.withdrawal.findMany({
    where: opts.allUsers ? {} : { userId },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toWithdrawalDTO),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function adminListWithdrawals(
  opts: Omit<ListOptions, 'allUsers'> & { status?: PaymentStatusValue } = {},
): Promise<{ items: WithdrawalDTO[]; nextCursor: string | null }> {
  const take = pageSize(opts.take);
  const rows = await prisma.withdrawal.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toWithdrawalDTO),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export interface DecideWithdrawalInput {
  id: string;
  adminUserId: string;
  decision: 'APPROVE' | 'REJECT';
  reason?: string;
  /** Operator-recorded chain transaction hash for a manual settlement. */
  txHash?: string;
  ip?: string | null;
}

/**
 * Admin decision on a withdrawal.
 *
 * APPROVE:
 *   1. PENDING → SENDING ("approved"; approvedBy set, WITHDRAWAL_APPROVED).
 *   2. If the payout API is configured, broadcast immediately via POST /payout
 *      and mark FINISHED + WITHDRAWAL_BROADCAST.
 *   3. If it is NOT configured, the row deliberately STAYS in the approved
 *      state: funds are settled by an operator from the treasury wallet, who
 *      then records the txHash (either through a second APPROVE call carrying
 *      `txHash`, or by the payout IPN). We never invent a txHash and never
 *      report a payout that did not happen.
 *
 * REJECT: the row goes to FAILED (the PaymentStatus enum has no REJECTED) with
 *   the admin's reason in the WITHDRAWAL_REJECTED audit row.
 */
export async function decideWithdrawal(input: DecideWithdrawalInput): Promise<WithdrawalDTO> {
  const { id, adminUserId, decision, reason, txHash, ip } = input;

  const row = await prisma.withdrawal.findUnique({ where: { id } });
  if (!row) throw ApiError.notFound('Withdrawal not found.');

  if (decision === 'REJECT') {
    if (row.status !== 'PENDING') {
      throw ApiError.conflict(`Only a PENDING withdrawal can be rejected (current status: ${row.status}).`);
    }
    const rejectionReason = (reason ?? '').trim();
    if (rejectionReason.length < 3) {
      throw ApiError.badRequest('A rejection reason is required.');
    }

    // Compare-and-swap on status. A plain read-then-write here is a race
    // between two admins (or a double-click): an APPROVE and a REJECT landing
    // concurrently both read PENDING, both write, and last-commit-wins can leave
    // a REJECTED withdrawal in a payable state. `updateMany` with the expected
    // status in the WHERE clause makes the transition atomic — the loser sees
    // count 0 and is rejected with a conflict instead of silently overwriting.
    const { count } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: WITHDRAWAL_STATUS_PENDING },
      data: { status: WITHDRAWAL_STATUS_REJECTED, approvedBy: adminUserId },
    });
    if (count !== 1) {
      throw ApiError.conflict(
        'That withdrawal was decided by someone else while you were reviewing it. Reload and check its current status.',
      );
    }
    const rejected = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });

    await recordAudit({
      action: AUDIT.WITHDRAWAL_REJECTED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        amountUsd: usd(row.amountUsd).toNumber(),
        reason: rejectionReason,
        appliedStatus: WITHDRAWAL_STATUS_REJECTED,
      },
    });

    return toWithdrawalDTO(rejected);
  }

  // ── APPROVE ──
  const alreadyApproved = row.status === WITHDRAWAL_STATUS_APPROVED;
  if (row.status !== 'PENDING' && !alreadyApproved) {
    throw ApiError.conflict(`Only a PENDING withdrawal can be approved (current status: ${row.status}).`);
  }

  const normalisedTxHash = (txHash ?? '').trim() || null;

  // Same compare-and-swap discipline on the approve path: only a still-PENDING
  // row may be moved to APPROVED. A concurrent REJECT therefore cannot be
  // overwritten into a payable state, and vice versa.
  let approved = row;
  if (!alreadyApproved) {
    const { count } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: WITHDRAWAL_STATUS_PENDING },
      data: { status: WITHDRAWAL_STATUS_APPROVED, approvedBy: adminUserId },
    });
    if (count !== 1) {
      throw ApiError.conflict(
        'That withdrawal was decided by someone else while you were reviewing it. Reload and check its current status.',
      );
    }
    approved = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });
  }

  if (!alreadyApproved) {
    await recordAudit({
      action: AUDIT.WITHDRAWAL_APPROVED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        amountUsd: usd(row.amountUsd).toNumber(),
        cryptoCurrency: row.cryptoCurrency,
        payoutApiConfigured: isPayoutConfigured(),
        settlement: isPayoutConfigured() ? 'AUTOMATED_PAYOUT' : 'MANUAL_SETTLEMENT_REQUIRED',
      },
    });
  }

  // Operator already settled this payout and is recording the proof.
  if (normalisedTxHash) {
    // Only an APPROVED (or already FINISHED) row may be marked settled; a row
    // that a concurrent decision moved back out of APPROVED must not be paid.
    const { count: settleCount } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: { in: [WITHDRAWAL_STATUS_APPROVED, 'FINISHED'] } },
      data: { status: 'FINISHED', txHash: normalisedTxHash, approvedBy: adminUserId },
    });
    if (settleCount !== 1) {
      throw ApiError.conflict(
        'That withdrawal is no longer approved, so it cannot be marked as settled.',
      );
    }
    const settled = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });

    await recordAudit({
      action: AUDIT.WITHDRAWAL_BROADCAST,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        txHash: normalisedTxHash,
        settlement: 'OPERATOR_RECORDED',
        amountUsd: usd(row.amountUsd).toNumber(),
      },
    });

    return toWithdrawalDTO(settled);
  }

  if (!isPayoutConfigured()) {
    // Stay in the approved state — manual settlement. Documented behaviour, not
    // a silent success: the DTO still reports SENDING (approved/pending payout)
    // with txHash null.
    return toWithdrawalDTO(approved);
  }

  // Automated broadcast. uniqueExternalId = our withdrawal id, so a retry can
  // never double-pay.
  let payoutId: string | null;
  try {
    const payout = await createPayout({
      address: approved.payoutAddress,
      amount: approved.amountUsd,
      currency: approved.cryptoCurrency,
      ipnCallbackUrl: `${serverEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/api/v1/payments/nowpayments/ipn`,
      uniqueExternalId: approved.id,
    });
    payoutId = payout.payoutId;
  } catch (err) {
    // The approval stands (row already SENDING); the broadcast is what failed.
    await recordAudit({
      action: AUDIT.WITHDRAWAL_FAILED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        amountUsd: usd(row.amountUsd).toNumber(),
        error: err instanceof Error ? err.message : 'unknown payout failure',
      },
    });
    throw err instanceof ApiError
      ? err
      : ApiError.paymentError('Payout broadcast failed. Settle this withdrawal manually.');
  }

  const broadcast = await prisma.withdrawal.update({
    where: { id: row.id },
    data: { status: 'FINISHED', approvedBy: adminUserId },
  });

  await recordAudit({
    action: AUDIT.WITHDRAWAL_BROADCAST,
    userId: row.userId,
    ipAddress: ip ?? null,
    details: {
      withdrawalId: row.id,
      adminUserId,
      payoutId,
      // The payout response returns a payout id, not a chain hash; txHash stays
      // null until the payout IPN or an operator supplies it.
      txHash: null,
      settlement: 'AUTOMATED_PAYOUT',
      amountUsd: usd(row.amountUsd).toNumber(),
    },
  });

  return toWithdrawalDTO(broadcast);
}

// ─── supported currencies ───────────────────────────────────────────────────

export interface SupportedCurrency {
  currency: string;
  symbol: string;
  label: string;
  network: string;
  /** True when the provider itself advertises this currency. */
  providerVerified: boolean;
  /** Provider minimum, in the crypto asset. Null when unavailable. */
  minPayAmount: number | null;
  /** Provider fiat equivalent of that minimum, USD. Null when unavailable. */
  minAmountUsd: number | null;
}

export interface SupportedCurrenciesResult {
  /** False when the provider's /currencies call failed this request — every
   *  currency then carries providerVerified:false and null minimums. */
  providerReachable: boolean;
  currencies: SupportedCurrency[];
}

/**
 * The currencies a client may use: the server-side allow-list
 * (NOWPAYMENTS_ALLOWED_CURRENCIES) intersected with what the provider actually
 * offers. Allow-listed currencies are ALWAYS returned — a provider outage must
 * not blank the deposit form — but they are flagged `providerVerified: false`
 * so the UI can warn and the backend can refuse to quote them.
 */
export async function listSupportedCurrencies(): Promise<SupportedCurrenciesResult> {
  const allowList = resolvedAllowedCurrencies();

  let advertised: string[] | null = null;
  try {
    advertised = await getAvailableCurrencies();
  } catch {
    advertised = null;
  }

  const providerReachable = advertised !== null;
  const providerSet = new Set(advertised ?? []);

  const currencies = await Promise.all(
    allowList.map(async (currency): Promise<SupportedCurrency> => {
      const meta = assetMeta(currency);
      const providerVerified = providerSet.has(currency);
      let minPayAmount: number | null = null;
      let minAmountUsd: number | null = null;

      if (providerVerified) {
        try {
          const min = await getMinimumPaymentAmount('usd', currency);
          minPayAmount = min.minAmount.toNumber();
          minAmountUsd = min.fiatEquivalent ? min.fiatEquivalent.toNumber() : null;
        } catch {
          // Per-currency minimum is best-effort metadata.
        }
      }

      return {
        currency,
        symbol: meta.symbol,
        label: meta.label,
        network: meta.network,
        providerVerified,
        minPayAmount,
        minAmountUsd,
      };
    }),
  );

  return { providerReachable, currencies };
}

/** Re-exported so route handlers and worker code share one signature constant. */
export { isCreditedStatus, mapProviderStatusToPaymentStatus };
export type { JsonObject };
