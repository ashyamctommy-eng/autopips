import { randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { serverEnv } from '@/lib/env';
import {
  resolvedAllowedCurrencies,
  resolvedPayoutAddressAllowlist,
  resolvedPayoutDailyCapUsd,
  resolvedPayoutTwoPersonApproval,
} from '@/server/modules/settings/settings.service';
import { D, toPrismaDecimal, usd, type Decimal, type Numeric } from '@/lib/money';
import { claimOnce } from '@/lib/rate-limit';
import { assetMeta } from '@/lib/contracts';
import { AUDIT, AUDIT_PAYOUT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
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
  getEstimatedPrice,
  getMinimumPaymentAmount,
  getPaymentStatus,
  isPayoutConfigured,
} from './nowpayments.client';
import {
  classifyIpnPayload,
  extractPayoutTxHash,
  isCreditedStatus,
  mapPayoutStatusToPaymentStatus,
  mapProviderStatusToPaymentStatus,
  parseIpnPayload,
  parsePayoutIpnPayload,
  verifyIpnSignature,
  type JsonObject,
  type PayoutIpnPayload,
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
 *   SENDING  → APPROVED: the payout was approved and (when the payout API is
 *              configured) broadcast. It is ALSO the state of an approved
 *              withdrawal awaiting an operator settlement. NOTHING IS DEBITED
 *              HERE: `SENDING` is an in-flight state that only RESERVES the
 *              balance (see IN_FLIGHT_WITHDRAWAL_STATUSES in ledger.ts).
 *   FINISHED → settled: the provider confirmed the payout (or an operator
 *              recorded the txHash). THIS is the debit: the equity formula
 *              treats a FINISHED withdrawal as money that left the platform.
 *   FAILED   → REJECTED by an admin, or a payout the provider reported as
 *              failed/returned. No money moved, so the reservation is released
 *              and equity is untouched.
 *
 * The ledger DEBIT therefore happens at SETTLEMENT, not at broadcast. An
 * earlier revision marked a withdrawal FINISHED the moment the provider
 * accepted the request, which debited client equity before any money had moved
 * and left no way to walk it back when the payout later failed.
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

// ─── payout controls (pure) ─────────────────────────────────────────────────

/**
 * Convert a withdrawal's USD figure into the COIN amount the provider must send.
 *
 * THE BUG THIS EXISTS FOR: a payout has no `price_amount`/`pay_currency` split
 * the way a deposit does — `createPayout` sends a single `amount` in the payout
 * currency. Passing `amountUsd` there told the treasury to send 100 BTC for a
 * $100 withdrawal. The provider's `/estimate` endpoint is the only authority
 * for the conversion, so its `estimated_amount` is what gets sent, and its
 * value is persisted as `Withdrawal.payAmount`.
 *
 * `/estimate` is INDICATIVE (it is a spot rate at request time, not a contract).
 * That is exactly why the returned COIN figure is stored on the row: the stored
 * `payAmount` is the recorded fact of what was actually broadcast, and a later
 * reviewer can compare it against the rate the provider quoted. It is NOT
 * recomputed on read.
 *
 * FAIL-CLOSED, AND NEVER A FALLBACK: a missing, non-finite, zero or negative
 * estimate REFUSES the broadcast. There is deliberately no "use the USD number"
 * branch — that branch IS the catastrophe. The caller audits the refusal and
 * leaves the withdrawal approved (SENDING) for manual settlement.
 */
export function resolvePayoutCoinAmount(input: {
  withdrawalId: string;
  amountUsd: Numeric;
  currency: string;
  estimatedAmount: Numeric | null | undefined;
}): Decimal {
  const usdAmount = D(input.amountUsd);
  const raw = input.estimatedAmount;

  const refuse = (why: string): never => {
    throw ApiError.paymentError(
      `Payout broadcast refused for withdrawal ${input.withdrawalId}: ${why} ` +
        `(requested $${usdAmount.toFixed(2)} in ${input.currency.toUpperCase()}). ` +
        'Refusing to send the USD figure as a coin amount. Settle this payout manually and record ' +
        'the txHash, or retry once the provider /estimate endpoint returns a usable amount.',
    );
  };

  if (raw === null || raw === undefined || raw === '') {
    return refuse('the provider returned no estimated_amount');
  }

  const coin = D(raw);
  if (!coin.isFinite() || coin.lessThanOrEqualTo(0)) {
    return refuse('the provider estimated a non-positive or non-finite amount');
  }

  return toPrismaDecimal(coin, 8);
}

/**
 * Payout-address allow-list. An EMPTY list means no restriction (the default,
 * so no operator has to configure anything to keep the previous behaviour).
 *
 * Comparison is case-insensitive: crypto addresses are case-sensitive in
 * general (base58), but the same EVM address has many valid checksummed
 * casings, and this is a typo/compromise gate rather than a uniqueness test.
 */
export function isPayoutAddressAllowed(payoutAddress: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const needle = payoutAddress.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === needle);
}

/**
 * Per-client, per-UTC-day USD cap. A cap <= 0 DISABLES the limit (the default).
 * Boundary is inclusive: a day that lands exactly ON the cap is allowed; only a
 * request that would exceed it is refused.
 *
 * Pure so the boundary is unit-testable without a database; the caller sums the
 * day's withdrawals inside the same row-locked transaction that reserves the
 * balance, so concurrent requests cannot each see a pre-cap total.
 */
export function exceedsPayoutDailyCap(input: {
  alreadyRequestedUsd: Numeric;
  requestedUsd: Numeric;
  capUsd: Numeric;
}): boolean {
  const cap = D(input.capUsd);
  if (cap.lessThanOrEqualTo(0)) return false;
  return D(input.alreadyRequestedUsd).plus(D(input.requestedUsd)).greaterThan(cap);
}

/** Start of the current UTC day — the window the daily cap sums over. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The outcome of the two-person rule for one payout action.
 *
 *   PROCEED                   broadcast/settle now
 *   AWAIT_SECOND_APPROVER     the first admin approved; a DIFFERENT admin must
 *                             approve before money moves
 *   REFUSED_SAME_ACTOR        the approver tried to release their own approval
 *   MANUAL_SETTLEMENT_EXEMPT  recording a txHash by hand is never gated
 */
export type TwoPersonVerdict =
  | 'PROCEED'
  | 'AWAIT_SECOND_APPROVER'
  | 'REFUSED_SAME_ACTOR'
  | 'MANUAL_SETTLEMENT_EXEMPT';

export interface TwoPersonDecision {
  verdict: TwoPersonVerdict;
  /** The second, distinct admin to record in `secondApprovedBy`. */
  secondApprovedBy: string | null;
  reason: string | null;
}

/**
 * Two-person approval for an AUTOMATED payout broadcast.
 *
 * Rationale: a broadcast is the platform itself moving client money, with no
 * treasury action behind it, so one compromised admin session must not be able
 * to release it. The rule therefore defaults ON and gates exactly that action.
 *
 * SINGLE-OPERATOR DEPLOYMENTS ARE NEVER LOCKED OUT, by construction:
 *   • `manualSettlement: true` always returns MANUAL_SETTLEMENT_EXEMPT. An
 *     operator recording a txHash for money they already sent from the treasury
 *     wallet is attested evidence, not an autonomous transfer — the system
 *     cannot and must not refuse to record what happened. It also means the
 *     rule can never leave a payout unsettleable.
 *   • `payout.two_person_approval = false` turns the requirement off entirely
 *     for a deployment that genuinely has one admin; documented on the setting
 *     and in `decideWithdrawal`.
 */
export function decideTwoPersonApproval(input: {
  twoPersonRequired: boolean;
  actorUserId: string;
  /** The admin who already approved (null when this is the first approval). */
  approvedBy: string | null;
  /** True when the actor is recording an operator-attested settlement. */
  manualSettlement: boolean;
}): TwoPersonDecision {
  if (input.manualSettlement) {
    return { verdict: 'MANUAL_SETTLEMENT_EXEMPT', secondApprovedBy: null, reason: null };
  }
  if (!input.twoPersonRequired) {
    return { verdict: 'PROCEED', secondApprovedBy: null, reason: null };
  }
  if (input.approvedBy === null) {
    // First approval. Recorded as approvedBy by the caller; no broadcast yet.
    return { verdict: 'AWAIT_SECOND_APPROVER', secondApprovedBy: null, reason: null };
  }
  if (input.approvedBy === input.actorUserId) {
    return {
      verdict: 'REFUSED_SAME_ACTOR',
      secondApprovedBy: null,
      reason:
        'Two-person approval is on for automated payouts: the admin who approved this withdrawal ' +
        'cannot also release it. A different admin must approve, or settle it manually with a txHash.',
    };
  }
  return { verdict: 'PROCEED', secondApprovedBy: input.actorUserId, reason: null };
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
  /** False when the payload matches no deposit/withdrawal we own. */
  matched: boolean;
  depositId?: string;
  withdrawalId?: string;
  status?: PaymentStatusValue;
  credited: boolean;
  /**
   * True when the body was signature-valid but its SHAPE matched neither a
   * deposit nor a payout. It was recorded as evidence and acknowledged with a
   * 2xx so the provider stops retrying an undeliverable body.
   */
  unrecognised?: boolean;
}

/**
 * Process a NOWPayments IPN — a DEPOSIT callback (credits equity) or a PAYOUT
 * callback (settles a withdrawal and only THERE debits equity).
 *
 * Idempotency argument (see also the REPLAY GUARD below):
 *
 *   0. The shape decides the route, but the HMAC is checked FIRST for both
 *      shapes. A payout IPN is reconciled by `reconcilePayoutIpn` under the
 *      same `claimOnce` discipline, keyed `payout-ipn:<withdrawalId>:<status>`,
 *      and its settlement is a compare-and-swap on the in-flight state, so a
 *      replayed payout callback cannot debit twice.
 * *   1. Redis `claimOnce("ipn:<payment_id>:<payment_status>", 86400)` gives each
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

  // (b) DISCRIMINATE ON SHAPE.
  //
  // One URL receives two unrelated webhook bodies: deposits (required
  // `payment_id`) and payouts (`{ id, withdrawals: [{ id, status,
  // unique_external_id }] }`). The payout body has no payment_id, so handing it
  // to the deposit parser fails validation with a 400 — and a 400 makes the
  // provider retry the same body forever. Discriminate first, then parse each
  // shape with its own schema.
  //
  // The HMAC check above has ALREADY run and passed; nothing here weakens or
  // duplicates it. An unrecognised shape is still signature-validated before it
  // can reach this point, so it is either a provider schema addition or a body
  // for a resource this build does not reconcile. Either way it is EVIDENCE:
  // record it verbatim in the audit log and ACK with 2xx. A 4xx would only
  // produce an infinite retry storm against a body we will never accept, while
  // discarding nothing — the audit row keeps what arrived.
  let ipnJson: unknown;
  try {
    ipnJson = JSON.parse(rawBody);
  } catch {
    // verifyIpnSignature already rejects an unparsable body; this is belt and
    // braces so the discriminator can never be handed undefined.
    throw ApiError.badRequest('IPN body is not valid JSON.');
  }

  const kind = classifyIpnPayload(ipnJson);
  if (kind === 'PAYOUT') {
    const payoutPayload = parsePayoutIpnPayload(rawBody);
    if (!payoutPayload) {
      // classifyIpnPayload said PAYOUT but the parser refused it (it only does
      // so on unparsable JSON, which was handled above). Treat as unrecognised.
      await recordAuditSafe({
        action: AUDIT_PAYOUT.IPN_UNRECOGNISED,
        details: { kind, reason: 'PAYOUT_PARSE_FAILED', ip: ip ?? null },
        ipAddress: ip ?? null,
      });
      return { duplicate: false, matched: false, credited: false, unrecognised: true };
    }
    return reconcilePayoutIpn({ payload: payoutPayload, ip });
  }

  if (kind === 'UNRECOGNISED') {
    await recordAuditSafe({
      action: AUDIT_PAYOUT.IPN_UNRECOGNISED,
      details: {
        kind,
        // The KEYS, never the values: enough for an operator to identify the
        // body, without copying whatever it contains into the audit table.
        payloadKeys:
          ipnJson !== null && typeof ipnJson === 'object' && !Array.isArray(ipnJson)
            ? Object.keys(ipnJson as Record<string, unknown>).sort()
            : [],
        ip: ip ?? null,
      },
      ipAddress: ip ?? null,
    });
    return { duplicate: false, matched: false, credited: false, unrecognised: true };
  }

  // (b') DEPOSIT — parse + locate
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

// ─── payout IPN reconciliation ──────────────────────────────────────────────

interface ReconcilePayoutIpnInput {
  payload: PayoutIpnPayload;
  ip?: string | null;
}

/**
 * Apply a payout IPN to the withdrawal it belongs to.
 *
 * Called ONLY from `handleIpn` after `verifyIpnSignature` has already passed,
 * so the body's provenance is established before a single row is read.
 *
 * MATCHING: the provider echoes our idempotency key as `unique_external_id`,
 * which is the withdrawal's own id — that is the primary match. The provider's
 * payout id (persisted at broadcast as `providerPayoutId`) is the fallback, so
 * a body whose external id was omitted can still be reconciled.
 *
 * APPLYING: only an in-flight (SENDING) withdrawal is advanced. A late IPN can
 * therefore never un-debit a settled payout or resurrect a failed one — money
 * that left stays left. FINISHED sets `settledAt` and (when the provider gives
 * one) `txHash`; FAILED releases the balance reservation. Any other status just
 * refreshes `providerStatus`/`ipnPayload`.
 */
async function reconcilePayoutIpn(input: ReconcilePayoutIpnInput): Promise<HandleIpnResult> {
  const { payload, ip } = input;

  let row = payload.uniqueExternalId
    ? await prisma.withdrawal.findUnique({ where: { id: payload.uniqueExternalId } })
    : null;
  if (!row && payload.payoutId) {
    row = await prisma.withdrawal.findFirst({ where: { providerPayoutId: payload.payoutId } });
  }

  if (!row) {
    // Signature-valid but unknown to us. Record it (the raw body is the
    // evidence) and ACK, so the provider does not retry an orphan forever.
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_IPN,
      ipAddress: ip ?? null,
      details: {
        matched: false,
        unrecognised: true,
        reason: 'NO_MATCHING_WITHDRAWAL',
        providerPayoutId: payload.payoutId,
        uniqueExternalId: payload.uniqueExternalId,
        providerStatus: payload.status,
        payload: payload.raw as unknown as Prisma.InputJsonValue,
        ip: ip ?? null,
      },
    });
    return { duplicate: false, matched: false, credited: false, unrecognised: true };
  }

  const providerStatus = payload.status;
  if (!providerStatus) {
    // A payout-shaped body whose withdrawals[] carried no status. Retain the
    // payload; there is no state to apply.
    await prisma.withdrawal.update({
      where: { id: row.id },
      data: {
        ipnPayload: payload.raw as unknown as Prisma.InputJsonValue,
        ...(payload.payoutId ? { providerPayoutId: payload.payoutId } : {}),
      },
    });
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_IPN,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        applied: false,
        reason: 'NO_PROVIDER_STATUS',
        providerPayoutId: payload.payoutId,
        ip: ip ?? null,
      },
    });
    return { duplicate: false, matched: true, withdrawalId: row.id, status: row.status, credited: false };
  }

  // REPLAY GUARD — the same single-use-slot discipline as the deposit path. A
  // retried (or captured-and-replayed) payout IPN hits this and returns
  // `duplicate:true` before any row is touched. It is keyed on OUR withdrawal id
  // and the provider status, so it cannot collide with the deposit keyspace.
  const claimed = await claimOnce(`payout-ipn:${row.id}:${providerStatus}`, 86_400);
  if (!claimed) {
    return { duplicate: true, matched: true, withdrawalId: row.id, status: row.status, credited: false };
  }

  const mapped = mapPayoutStatusToPaymentStatus(providerStatus);
  const settled = mapped === 'FINISHED';
  const failed = mapped === 'FAILED';
  const txHash = extractPayoutTxHash(payload.raw);

  const evidence: Prisma.WithdrawalUpdateManyMutationInput = {
    providerStatus,
    ipnPayload: payload.raw as unknown as Prisma.InputJsonValue,
    ...(payload.payoutId ? { providerPayoutId: payload.payoutId } : {}),
  };

  let applied = false;
  if (settled || failed) {
    // Compare-and-swap on the in-flight state: only SENDING may become terminal.
    const { count } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: WITHDRAWAL_STATUS_APPROVED },
      data: {
        ...evidence,
        status: settled ? 'FINISHED' : 'FAILED',
        // `settledAt` is set ONLY for a real settlement. A failed/returned payout
        // never moved money, so there is no settlement to date.
        settledAt: settled ? new Date() : null,
        ...(settled && txHash ? { txHash } : {}),
      },
    });
    applied = count === 1;
    if (!applied) {
      // Already terminal (or otherwise not in flight). Retain the evidence
      // without re-opening the state.
      await prisma.withdrawal.update({ where: { id: row.id }, data: evidence });
    }
  } else {
    // Still in flight (waiting/processing/sending, or an unknown status):
    // record what the counterparty said, change no state, debit nothing.
    await prisma.withdrawal.update({ where: { id: row.id }, data: evidence });
  }

  const updated = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });

  await recordAudit({
    action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_IPN,
    userId: row.userId,
    ipAddress: ip ?? null,
    details: {
      withdrawalId: row.id,
      matched: true,
      applied,
      providerStatus,
      mappedStatus: mapped,
      providerPayoutId: updated.providerPayoutId,
      payAmount: updated.payAmount === null ? null : updated.payAmount.toString(),
      txHash: updated.txHash,
      settledAt: updated.settledAt?.toISOString() ?? null,
      appliedStatus: updated.status,
      ledger: settled && applied ? 'EQUITY_DEBITED_AT_SETTLEMENT' : 'NO_LEDGER_CHANGE',
      ip: ip ?? null,
    },
  });

  if (settled && applied) {
    await recordAudit({
      action: AUDIT.WITHDRAWAL_BROADCAST,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        providerStatus,
        providerPayoutId: updated.providerPayoutId,
        txHash: updated.txHash,
        settlement: 'PROVIDER_IPN',
        settledAt: updated.settledAt?.toISOString() ?? null,
        ledger: 'EQUITY_DEBITED_AT_SETTLEMENT',
        amountUsd: usd(updated.amountUsd).toNumber(),
      },
    });
  }

  if (failed && applied) {
    await recordAudit({
      action: AUDIT.WITHDRAWAL_FAILED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        stage: 'PROVIDER_IPN',
        providerStatus,
        providerPayoutId: updated.providerPayoutId,
        ledger: 'RESERVATION_RELEASED_NOT_DEBITED',
        amountUsd: usd(updated.amountUsd).toNumber(),
      },
    });
  }

  return {
    duplicate: false,
    matched: true,
    withdrawalId: updated.id,
    status: updated.status,
    credited: false,
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

  // Operator allow-list. Empty = no restriction (the default). Enforced here so
  // a non-allow-listed address never becomes an approved payout, and again at
  // broadcast time so a list tightened mid-flight still bites.
  const addressAllowlist = resolvedPayoutAddressAllowlist();
  if (!isPayoutAddressAllowed(payoutAddress, addressAllowlist)) {
    throw ApiError.badRequest(
      'That payout address is not on the operator allow-list. Contact support to have it added before requesting this withdrawal.',
    );
  }

  const dailyCapUsd = D(resolvedPayoutDailyCapUsd());

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

    // Per-client daily payout cap. Summed over the client's NON-FAILED
    // withdrawals since UTC midnight, INSIDE the same `FOR UPDATE` transaction
    // that reserves the balance: a concurrent pair of requests would otherwise
    // both read a pre-cap total and both pass. A cap of 0 disables the check,
    // so an unconfigured deployment behaves exactly as before.
    if (dailyCapUsd.greaterThan(0)) {
      const dayAggregate = await tx.withdrawal.aggregate({
        where: {
          userId: user.id,
          createdAt: { gte: utcDayStart() },
          status: { notIn: [WITHDRAWAL_STATUS_REJECTED, 'REFUNDED'] },
        },
        _sum: { amountUsd: true },
      });
      const alreadyRequested = D(dayAggregate._sum.amountUsd ?? 0);
      if (
        exceedsPayoutDailyCap({
          alreadyRequestedUsd: alreadyRequested,
          requestedUsd: amount,
          capUsd: dailyCapUsd,
        })
      ) {
        throw ApiError.badRequest(
          `Daily payout limit reached: $${alreadyRequested.toFixed(2)} already requested since 00:00 UTC ` +
            `and this request of $${amount.toFixed(2)} would exceed the $${dailyCapUsd.toFixed(2)} daily cap. ` +
            'Try again after 00:00 UTC.',
        );
      }
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

/**
 * A deposit row as the ADMIN console sees it: the same DTO the client gets, plus
 * the account it belongs to. The console is an operator surface — a list of
 * amounts with no client attached would be unactionable.
 */
export type AdminDepositRow = DepositDTO & { userEmail: string; userName: string };

/** Platform-wide deposit list, newest first. */
export async function adminListDeposits(
  opts: Omit<ListOptions, 'allUsers'> & { status?: PaymentStatusValue; userId?: string } = {},
): Promise<{ items: AdminDepositRow[]; nextCursor: string | null }> {
  const take = pageSize(opts.take);
  const rows = await prisma.deposit.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { user: { select: { email: true, fullName: true } } },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map((row) => ({
      ...toDepositDTO(row),
      userEmail: row.user.email,
      userName: row.user.fullName,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export interface CreditDepositInput {
  /** Client account to credit, by id or email (the console searches by email). */
  userId: string;
  amountUsd: number;
  /** Why the credit exists — kept in the audit row and on the deposit row. */
  note: string;
  adminUserId: string;
  adminEmail: string;
  ip?: string | null;
}

/** Ceiling for a single manual credit; anything larger is a fat finger. */
const MAX_MANUAL_CREDIT_USD = 1_000_000;

/**
 * Credit a client's balance BY HAND.
 *
 * There is no chain payment here, and nothing pretends there was:
 *   • the row is written with `paymentId = manual:<uuid>` so it can never be
 *     mistaken for, or matched against, a provider payment;
 *   • `cryptoCurrency` is `MANUAL` and `payAmount` equals the USD credited,
 *     because no conversion took place;
 *   • the status is CONFIRMED, which is the SAME state the ledger credits equity
 *     from — so the balance the client sees is produced by the ordinary formula,
 *     not by a special case;
 *   • it is audited as ADMIN_DEPOSIT_CREDITED with the operator's identity and
 *     their note.
 *
 * Rejections are deliberate: staff accounts are refused (crediting an operator's
 * own balance is a books-are-wrong situation, not a feature) and the amount is
 * bounded.
 */
export async function adminCreditDeposit(input: CreditDepositInput): Promise<AdminDepositRow> {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw ApiError.notFound('No such client account.');
  if (isStaff(user)) {
    throw ApiError.badRequest(
      'That account is a staff account; manual credits are for client balances only.',
    );
  }

  const amount = D(input.amountUsd);
  if (!Number.isFinite(input.amountUsd) || amount.lessThanOrEqualTo(0)) {
    throw ApiError.badRequest('A credit must be a positive amount.');
  }
  if (amount.decimalPlaces() > 2) {
    throw ApiError.badRequest('A credit may not have more than 2 decimal places.');
  }
  if (amount.greaterThan(MAX_MANUAL_CREDIT_USD)) {
    throw ApiError.badRequest(`A single manual credit may not exceed ${MAX_MANUAL_CREDIT_USD} USD.`);
  }

  const note = input.note.trim();
  if (note.length < 3) {
    throw ApiError.badRequest('A reason of at least 3 characters is required for a manual credit.');
  }

  const row = await prisma.deposit.create({
    data: {
      userId: user.id,
      amountUsd: toPrismaDecimal(amount, 2),
      cryptoCurrency: 'MANUAL',
      paymentId: `manual:${randomUUID()}`,
      depositAddress: 'manual',
      payAmount: toPrismaDecimal(amount, 8),
      status: 'CONFIRMED',
      ipnPayload: {
        source: 'ADMIN_MANUAL_CREDIT',
        actorUserId: input.adminUserId,
        actorEmail: input.adminEmail,
        note,
        creditedAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue,
    },
    include: { user: { select: { email: true, fullName: true } } },
  });

  await recordAudit({
    action: AUDIT.ADMIN_DEPOSIT_CREDITED,
    userId: user.id,
    ipAddress: input.ip ?? null,
    details: {
      depositId: row.id,
      amountUsd: amount.toNumber(),
      currency: 'USD',
      method: 'MANUAL',
      actor: input.adminEmail,
      note,
    },
  });

  return { ...toDepositDTO(row), userEmail: row.user.email, userName: row.user.fullName };
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
 *   1. PENDING → SENDING ("approved"; approvedBy + approvedAt set,
 *      WITHDRAWAL_APPROVED). The ledger debit does NOT happen here — SENDING is
 *      an in-flight state that only reserves the balance.
 *   2. If the payout API is configured, the row is BROADCAST via POST /payout
 *      and STAYS SENDING. The provider's payout id, status and the converted
 *      coin amount (`payAmount`) are persisted; `settledAt` stays null. The
 *      transition to FINISHED — and therefore the equity debit — happens when
 *      the payout IPN confirms settlement, or when an operator records a
 *      txHash by hand.
 *   3. If it is NOT configured, the row stays in the approved state: funds are
 *      settled by an operator from the treasury wallet, who records the txHash
 *      (on this call, via the payout IPN, or by a later APPROVE). We never
 *      invent a txHash and never report a payout that did not happen.
 *
 * TWO-PERSON APPROVAL (default ON, `payout.two_person_approval`): an automated
 *   broadcast needs a second, DISTINCT admin. The first APPROVE records the
 *   approval and stops; a different admin's APPROVE releases it and is stored
 *   in `secondApprovedBy`. The SAME admin trying to release their own approval
 *   is refused. This gate covers AUTONOMOUS broadcasts only. Two consequences
 *   are deliberate and important:
 *   • Manual settlement (recording a txHash) is NEVER gated, so the rule can
 *     never leave a payout unsettleable and a single-operator deployment can
 *     always settle. See `decideTwoPersonApproval`.
 *   • A deployment with genuinely one admin sets
 *     `payout.two_person_approval = false` to re-enable automated broadcasts.
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
  const twoPersonRequired = resolvedPayoutTwoPersonApproval();
  const payoutConfigured = isPayoutConfigured();

  // Same compare-and-swap discipline on the approve path: only a still-PENDING
  // row may be moved to APPROVED. A concurrent REJECT therefore cannot be
  // overwritten into a payable state, and vice versa.
  let approved = row;
  if (!alreadyApproved) {
    const { count } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: WITHDRAWAL_STATUS_PENDING },
      data: {
        status: WITHDRAWAL_STATUS_APPROVED,
        approvedBy: adminUserId,
        // The approval time is a recorded fact, not derived from updatedAt.
        approvedAt: new Date(),
      },
    });
    if (count !== 1) {
      throw ApiError.conflict(
        'That withdrawal was decided by someone else while you were reviewing it. Reload and check its current status.',
      );
    }
    approved = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });
  }

  // Defensive: a SENDING row always carries an approver under this state
  // machine, but a row written by an older/other process might not. Adopt this
  // actor as the first approver rather than leaving the payout permanently
  // un-broadcastable (the two-person rule would otherwise wait for a first
  // approval that can never come).
  if (alreadyApproved && approved.approvedBy === null) {
    approved = await prisma.withdrawal.update({
      where: { id: row.id },
      data: { approvedBy: adminUserId, approvedAt: approved.approvedAt ?? new Date() },
    });
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
        payoutApiConfigured: payoutConfigured,
        twoPersonApprovalRequired: twoPersonRequired,
        settlement: payoutConfigured ? 'AUTOMATED_PAYOUT' : 'MANUAL_SETTLEMENT_REQUIRED',
        ledger: 'NO_DEBIT_UNTIL_SETTLEMENT',
      },
    });
  }

  // ── Operator-attested manual settlement ───────────────────────────────────
  // Only an APPROVED (or already FINISHED) row may be marked settled, and this
  // branch is NEVER gated by the two-person rule: it records money that already
  // left the treasury wallet by hand, and refusing to record it would leave the
  // ledger permanently out of step with reality. It is also what keeps a
  // single-operator deployment able to settle anything at all.
  if (normalisedTxHash) {
    const twoPerson = decideTwoPersonApproval({
      twoPersonRequired,
      actorUserId: adminUserId,
      approvedBy: approved.approvedBy,
      manualSettlement: true,
    });

    const { count: settleCount } = await prisma.withdrawal.updateMany({
      where: { id: row.id, status: { in: [WITHDRAWAL_STATUS_APPROVED, 'FINISHED'] } },
      data: {
        status: 'FINISHED',
        txHash: normalisedTxHash,
        approvedBy: adminUserId,
        // SETTLEMENT is what debits equity — see the ledger's
        // DEBITED_PAYMENT_STATUSES (FINISHED only).
        settledAt: new Date(),
      },
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
        twoPersonVerdict: twoPerson.verdict,
        settledAt: settled.settledAt?.toISOString() ?? null,
        ledger: 'EQUITY_DEBITED_AT_SETTLEMENT',
        amountUsd: usd(row.amountUsd).toNumber(),
      },
    });

    return toWithdrawalDTO(settled);
  }

  if (!payoutConfigured) {
    // Stay in the approved state — manual settlement. Documented behaviour, not
    // a silent success: the DTO still reports SENDING (approved/pending payout)
    // with txHash null, and equity is NOT debited.
    return toWithdrawalDTO(approved);
  }

  // ── Automated broadcast ───────────────────────────────────────────────────
  // TWO-PERSON GATE. The first approval only records the approval; a different
  // admin must release it. Same-actor release is refused outright.
  const twoPerson = decideTwoPersonApproval({
    twoPersonRequired,
    actorUserId: adminUserId,
    approvedBy: alreadyApproved ? approved.approvedBy : null,
    manualSettlement: false,
  });

  if (twoPerson.verdict === 'AWAIT_SECOND_APPROVER') {
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_SECOND_APPROVAL_REQUIRED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        approverUserId: adminUserId,
        amountUsd: usd(row.amountUsd).toNumber(),
        cryptoCurrency: row.cryptoCurrency,
        note: 'Approved and held: a second, different admin must approve before the payout is broadcast.',
      },
    });
    return toWithdrawalDTO(approved);
  }

  if (twoPerson.verdict !== 'PROCEED') {
    throw ApiError.conflict(
      twoPerson.reason ?? 'A second, different admin must approve this payout before it can be released.',
    );
  }

  // Address allow-list, re-checked at the moment of broadcast: the list may have
  // been tightened between the client's request and this approval.
  const addressAllowlist = resolvedPayoutAddressAllowlist();
  if (!isPayoutAddressAllowed(approved.payoutAddress, addressAllowlist)) {
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_REFUSED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        stage: 'ADDRESS_ALLOWLIST',
        outcome: 'REFUSED',
        payoutAddress: approved.payoutAddress,
        allowlistSize: addressAllowlist.length,
      },
    });
    throw ApiError.badRequest(
      'That payout address is not on the operator allow-list (setting: payout.address_allowlist). ' +
        'Add it to the allow-list before broadcasting, or settle this payout manually.',
    );
  }

  // STEP 1 — CONVERT USD → COIN before anything is broadcast. `amountUsd` is a
  // USD figure; POST /payout has no price/currency split, so sending it as the
  // `amount` would order that many COINS. The provider's /estimate is the only
  // authority for the conversion, and its result is persisted as payAmount.
  let estimate;
  try {
    estimate = await getEstimatedPrice(approved.amountUsd, approved.cryptoCurrency);
  } catch (err) {
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_REFUSED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        stage: 'PROVIDER_ESTIMATE',
        outcome: 'PROVIDER_FAILURE',
        amountUsd: usd(row.amountUsd).toNumber(),
        cryptoCurrency: row.cryptoCurrency,
        error: err instanceof Error ? err.message : 'unknown estimate failure',
      },
    });
    throw err instanceof ApiError
      ? err
      : ApiError.paymentError(
          'Could not obtain a conversion estimate from NOWPayments, so the payout was not broadcast. Settle it manually.',
        );
  }

  let payAmount: Decimal;
  try {
    payAmount = resolvePayoutCoinAmount({
      withdrawalId: approved.id,
      amountUsd: approved.amountUsd,
      currency: approved.cryptoCurrency,
      estimatedAmount: estimate.estimatedAmount,
    });
  } catch (err) {
    // FAIL-CLOSED: no usable estimate means no broadcast. Nothing is persisted
    // and the row stays approved (SENDING) for manual settlement. The USD figure
    // is recorded in the audit row for the reviewer; it is never sent.
    await recordAudit({
      action: AUDIT_PAYOUT.WITHDRAWAL_PAYOUT_REFUSED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        stage: 'CONVERSION_GUARD',
        outcome: 'REFUSED',
        amountUsd: usd(row.amountUsd).toNumber(),
        cryptoCurrency: row.cryptoCurrency,
        estimatedAmount:
          estimate.estimatedAmount === null || estimate.estimatedAmount === undefined
            ? null
            : estimate.estimatedAmount.toString(),
      },
    });
    throw err instanceof ApiError
      ? err
      : ApiError.paymentError(
          'Payout conversion failed, so the payout was not broadcast. Settle it manually.',
        );
  }

  // STEP 2 — BROADCAST the COIN amount. uniqueExternalId = our withdrawal id, so
  // a retry can never double-pay.
  let payoutId: string | null;
  let payoutStatus: string | null;
  try {
    const payout = await createPayout({
      address: approved.payoutAddress,
      // The COIN amount from the provider's estimate — never `amountUsd`.
      amount: payAmount,
      currency: approved.cryptoCurrency,
      ipnCallbackUrl: `${serverEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/api/v1/payments/nowpayments/ipn`,
      uniqueExternalId: approved.id,
    });
    payoutId = payout.payoutId;
    payoutStatus = payout.status;
  } catch (err) {
    // The approval stands (row already SENDING); the broadcast is what failed.
    // Nothing was debited, so there is nothing to walk back.
    await recordAudit({
      action: AUDIT.WITHDRAWAL_FAILED,
      userId: row.userId,
      ipAddress: ip ?? null,
      details: {
        withdrawalId: row.id,
        adminUserId,
        stage: 'PROVIDER_PAYOUT',
        amountUsd: usd(row.amountUsd).toNumber(),
        payAmount: payAmount.toString(),
        cryptoCurrency: row.cryptoCurrency,
        error: err instanceof Error ? err.message : 'unknown payout failure',
      },
    });
    throw err instanceof ApiError
      ? err
      : ApiError.paymentError('Payout broadcast failed. Settle this withdrawal manually.');
  }

  // STEP 3 — RECORD the broadcast, but STAY IN SENDING. The payout id and status
  // are persisted so the payout can be looked up again; `settledAt` stays null
  // and equity is NOT debited until the payout IPN (or an operator) confirms.
  const { count: broadcastCount } = await prisma.withdrawal.updateMany({
    where: { id: row.id, status: WITHDRAWAL_STATUS_APPROVED },
    data: {
      status: WITHDRAWAL_STATUS_APPROVED,
      approvedBy: approved.approvedBy ?? adminUserId,
      secondApprovedBy: twoPerson.secondApprovedBy ?? approved.secondApprovedBy,
      payAmount: toPrismaDecimal(payAmount, 8),
      providerPayoutId: payoutId,
      providerStatus: payoutStatus,
      settledAt: null,
    },
  });
  if (broadcastCount !== 1) {
    throw ApiError.conflict(
      'That withdrawal changed state while the payout was being broadcast. Reload and reconcile it before retrying.',
    );
  }
  const broadcast = await prisma.withdrawal.findUniqueOrThrow({ where: { id: row.id } });

  await recordAudit({
    action: AUDIT.WITHDRAWAL_BROADCAST,
    userId: row.userId,
    ipAddress: ip ?? null,
    details: {
      withdrawalId: row.id,
      adminUserId,
      payoutId,
      providerStatus: payoutStatus,
      // The COIN amount actually sent, and the USD figure it was converted
      // from — both recorded so the rate can be reviewed later.
      payAmount: payAmount.toFixed(8),
      cryptoCurrency: row.cryptoCurrency,
      amountUsd: usd(row.amountUsd).toNumber(),
      secondApprovedBy: twoPerson.secondApprovedBy,
      // The payout response returns a payout id, not a chain hash; txHash stays
      // null until the payout IPN or an operator supplies it.
      txHash: null,
      settlement: 'AUTOMATED_PAYOUT',
      appliedStatus: WITHDRAWAL_STATUS_APPROVED,
      ledger: 'NO_DEBIT_UNTIL_SETTLEMENT',
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
