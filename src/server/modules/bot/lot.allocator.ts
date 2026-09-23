/**
 * Master → client lot allocation.
 *
 * PURE: no I/O, no Prisma, no clock, no randomness. Given the master lot size,
 * the master account equity and a client's capital, it returns the client lot
 * size for every investment.
 *
 * ONLY rounds DOWN. A client is never given more exposure than the ratio grants,
 * the result is never negative and never NaN: when a volume cannot be produced
 * honestly the allocation is marked `skipped` with a reason instead.
 *
 *   MASTER_TO_CLIENT_FORMULA
 *     Client Lot Size = Master Lot Size * (Client Investment Capital / Master Account Equity)
 */

import { D, Decimal, type Numeric } from '@/lib/money';
import type { SymbolSpec } from '../broker/broker.types';
import type { LotAllocation } from './bot.types';

/** The documented copy-trade formula — surfaced in the UI and in audit details. */
export const MASTER_TO_CLIENT_FORMULA =
  'Client Lot Size = Master Lot Size * (Client Investment Capital / Master Account Equity)';

/** Ratio precision kept on `LotAllocation.ratio` for auditability. */
const RATIO_DP = 10;

/** The subset of a symbol specification the allocator needs. */
export type AllocationSpec = Pick<SymbolSpec, 'volumeStep' | 'minVolume' | 'maxVolume'>;

/** One investment to allocate for. */
export interface AllocationInvestment {
  investmentId: string;
  /** Funded capital in USD. `null` when the ledger has no capital (unknown). */
  capitalUsd: Numeric | null;
  /** Optional per-investment volume cap; the symbol's maxVolume applies otherwise. */
  maxVolume?: Numeric | null;
}

export interface AllocateLotInput {
  masterVolume: Numeric;
  masterEquity: Numeric;
  symbolSpec: AllocationSpec;
  investment: AllocationInvestment;
  minClientCapitalUsd: Numeric;
}

export interface AllocateAcrossInput {
  masterVolume: Numeric;
  masterEquity: Numeric;
  symbolSpec: AllocationSpec;
  minClientCapitalUsd: Numeric;
  investments: AllocationInvestment[];
}

/** Decimal places implied by a volume step (0.01 → 2, 0.001 → 3). */
function stepDecimals(step: Decimal): number {
  const asString = step.toFixed(10).replace(/0+$/, '');
  const dot = asString.indexOf('.');
  return dot === -1 ? 0 : asString.length - dot - 1;
}

/**
 * Floors a volume DOWN to a multiple of `step` (never up, never to zero unless the
 * input rounds below one step). Returns a Decimal quantised to the step's own
 * precision so 0.1 + 0.2 style artefacts cannot leak into a broker order.
 */
export function roundToVolumeStep(volume: Numeric, step: Numeric): Decimal {
  const stepD = D(step);
  const value = D(volume);
  if (!stepD.isFinite() || stepD.lessThanOrEqualTo(0) || !value.isFinite()) return D(0);
  const steps = value.div(stepD).floor();
  const floored = steps.times(stepD);
  if (floored.lessThan(0)) return D(0);
  return floored.toDecimalPlaces(stepDecimals(stepD), Decimal.ROUND_DOWN);
}

function skipped(
  investmentId: string,
  reason: NonNullable<LotAllocation['skipReason']>,
  ratio: Decimal,
): LotAllocation {
  return {
    investmentId,
    clientVolume: 0,
    skipped: true,
    skipReason: reason,
    ratio: ratio.toDecimalPlaces(RATIO_DP, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

/**
 * Allocates one client lot size.
 *
 * Skip (never round up, never invent) when:
 *   - the master equity is <= 0 or unusable            → MASTER_EQUITY_ZERO
 *   - the client capital is unknown/unusable           → CAPITAL_UNKNOWN
 *   - the client capital is below `minClientCapitalUsd` → BELOW_MIN_CAPITAL
 *   - the scaled volume floors below the symbol's minVolume (or to 0, or to a
 *     non-finite value)                                → BELOW_MIN_VOLUME
 *
 * The result is clamped to `[0, min(symbolMaxVolume, investment.maxVolume)]`.
 */
export function allocateLot(input: AllocateLotInput): LotAllocation {
  const { investment, symbolSpec } = input;
  const masterEquity = D(input.masterEquity);
  const masterVolume = D(input.masterVolume);

  if (!masterEquity.isFinite() || masterEquity.lessThanOrEqualTo(0)) {
    return skipped(investment.investmentId, 'MASTER_EQUITY_ZERO', D(0));
  }

  const capitalRaw = investment.capitalUsd;
  if (capitalRaw === null || capitalRaw === undefined || !D(capitalRaw).isFinite()) {
    return skipped(investment.investmentId, 'CAPITAL_UNKNOWN', D(0));
  }
  const capital = D(capitalRaw);
  const minCapital = D(input.minClientCapitalUsd);
  if (capital.lessThan(minCapital)) {
    return skipped(investment.investmentId, 'BELOW_MIN_CAPITAL', capital.div(masterEquity));
  }

  const ratio = capital.div(masterEquity);
  const step = D(symbolSpec.volumeStep);
  const symbolMax = D(symbolSpec.maxVolume);
  const investmentMax =
    investment.maxVolume === null || investment.maxVolume === undefined ? symbolMax : D(investment.maxVolume);
  const effectiveMax = Decimal.min(symbolMax, investmentMax);

  const raw = masterVolume.times(ratio);
  if (!raw.isFinite() || raw.lessThanOrEqualTo(0)) {
    return skipped(investment.investmentId, 'BELOW_MIN_VOLUME', ratio);
  }

  const floored = roundToVolumeStep(raw, step);
  const clamped = Decimal.min(floored, effectiveMax.greaterThanOrEqualTo(0) ? effectiveMax : floored);
  const minVolume = D(symbolSpec.minVolume);

  if (!clamped.isFinite() || clamped.lessThanOrEqualTo(0) || clamped.lessThan(minVolume)) {
    return skipped(investment.investmentId, 'BELOW_MIN_VOLUME', ratio);
  }

  return {
    investmentId: investment.investmentId,
    clientVolume: clamped.toNumber(),
    skipped: false,
    ratio: ratio.toDecimalPlaces(RATIO_DP, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

/**
 * Allocates for every investment, ordered deterministically by `investmentId` so
 * two runs (and two replicas) produce byte-identical order lists.
 */
export function allocateAcrossInvestments(input: AllocateAcrossInput): LotAllocation[] {
  return [...input.investments]
    .sort((a, b) => (a.investmentId < b.investmentId ? -1 : a.investmentId > b.investmentId ? 1 : 0))
    .map((investment) =>
      allocateLot({
        masterVolume: input.masterVolume,
        masterEquity: input.masterEquity,
        symbolSpec: input.symbolSpec,
        investment,
        minClientCapitalUsd: input.minClientCapitalUsd,
      }),
    );
}
