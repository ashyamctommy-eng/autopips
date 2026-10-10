import { z } from 'zod';
import { RISK_LEVELS } from '@/lib/contracts';

/**
 * Trading-plan input contract — THE single source of truth for plan create and
 * plan update, shared by `admin.service.ts` and the plan routes so both agree on
 * exactly one shape.
 *
 * Business context:
 *  - Directive #2 (no guaranteed returns): target returns are percentages of
 *    the deployed capital and are bounded to a finite, non-negative range so a
 *    plan cannot advertise a nonsensical "guarantee" figure. The UI must always
 *    render them with TARGET_RETURN_LABEL.
 *  - `maxDrawdown` is the risk stop the bot engine enforces
 *    (`bot/risk.engine.ts` rejects every order once drawdown reaches it), so it
 *    must be strictly positive — a 0% limit would mean "never trade".
 *  - `minInvestment` / `maxInvestment` bounds are hard, not indicative: they are
 *    the range a client is allowed to deploy on the plan.
 */

/** Sanity ceiling for a single USD amount — far inside Postgres Decimal(18,2). */
const MAX_USD = 1_000_000_000;
/** Ten years. A duration beyond that is a data-entry error, not a strategy. */
const MAX_DURATION_DAYS = 3_650;

const usdAmountSchema = (label: string) =>
  z
    .number({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} must be a number.`,
    })
    .finite(`${label} must be a finite number.`)
    .positive(`${label} must be greater than zero.`)
    .max(MAX_USD, `${label} must not exceed ${MAX_USD}.`);

/** Percentages are stored in percent units (20 = 20%), so 0..100 is the range. */
const percentSchema = (label: string) =>
  z
    .number({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} must be a number.`,
    })
    .finite(`${label} must be a finite number.`)
    .min(0, `${label} cannot be negative.`)
    .max(100, `${label} cannot exceed 100%.`);

const planFieldsShape = {
  name: z
    .string({ required_error: 'Plan name is required.' })
    .trim()
    .min(3, 'Plan name must be at least 3 characters.')
    .max(120, 'Plan name must be at most 120 characters.'),
  description: z
    .string({ required_error: 'Plan description is required.' })
    .trim()
    .min(10, 'Plan description must be at least 10 characters.')
    .max(2_000, 'Plan description must be at most 2000 characters.'),
  minInvestment: usdAmountSchema('Minimum investment'),
  maxInvestment: usdAmountSchema('Maximum investment'),
  durationDays: z
    .number({
      required_error: 'Duration is required.',
      invalid_type_error: 'Duration must be a number of days.',
    })
    .int('Duration must be a whole number of days.')
    .min(1, 'Duration must be at least 1 day.')
    .max(MAX_DURATION_DAYS, `Duration must be at most ${MAX_DURATION_DAYS} days.`),
  targetReturnMin: percentSchema('Minimum target return'),
  targetReturnMax: percentSchema('Maximum target return'),
  riskLevel: z.enum(RISK_LEVELS, {
    errorMap: () => ({ message: 'Risk level must be LOW, MEDIUM or HIGH.' }),
  }),
  performanceFee: percentSchema('Performance fee'),
  managementFee: percentSchema('Management fee'),
  maxDrawdown: percentSchema('Maximum drawdown').refine(
    (value) => value > 0,
    'Maximum drawdown must be greater than 0% — a plan that may not draw down at all can never trade.',
  ),
};

export type PlanFieldsShape = typeof planFieldsShape;

/** The cross-field rules, applied to a COMPLETE plan (never to a partial patch). */
interface PlanBounds {
  minInvestment: number;
  maxInvestment: number;
  targetReturnMin: number;
  targetReturnMax: number;
}

function checkPlanBounds(value: PlanBounds, ctx: z.RefinementCtx): void {
  if (value.maxInvestment <= value.minInvestment) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxInvestment'],
      message: 'Maximum investment must be greater than the minimum investment.',
    });
  }
  if (value.targetReturnMax < value.targetReturnMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetReturnMax'],
      message: 'Maximum target return must be greater than or equal to the minimum target return.',
    });
  }
}

/**
 * Create payload. `isActive` defaults to true — a plan that was created but not
 * switched off is intended to be offered.
 */
export const planInputSchema = z
  .object({ ...planFieldsShape, isActive: z.boolean().default(true) })
  .superRefine(checkPlanBounds);

/**
 * Update payload: every field optional (PATCH semantics).
 *
 * Only per-field bounds are enforced here. `admin.service.updatePlan` merges the
 * patch onto the stored plan and re-validates the RESULT with `planInputSchema`,
 * so cross-field rules (max > min, target max ≥ target min) are checked against
 * the plan that will actually exist — not against the fragment that was sent.
 */
export const planUpdateSchema = z
  .object({ ...planFieldsShape, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update.',
  });

/** Validated create input — the type both the route and the service agree on. */
export type PlanInput = z.infer<typeof planInputSchema>;
/** Validated update patch. */
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;

/**
 * A COMPLETE, VALID example of the create payload — the format an operator can
 * copy into the console (or into a support ticket) instead of guessing which
 * field names, units and ranges the API accepts.
 *
 * It lives next to the schema, not in the UI, for one reason: it is asserted
 * against `planInputSchema` by `tests/plan-example.test.ts`, so the example can
 * never drift from the contract it documents. An example that the API would
 * reject is worse than no example at all.
 *
 * The figures are ILLUSTRATIVE — a mid-risk, mid-duration shape that exercises
 * every field and its bounds. They are not a recommendation, a forecast, or an
 * offer: target returns are the indicative range a plan may seek and are always
 * rendered with the non-guarantee disclaimer.
 */
export const PLAN_EXAMPLE: PlanInput = {
  name: 'Example — Balanced Momentum 30',
  description:
    'Illustrative plan shape for a 30-day cycle: positions are sized from a fixed risk budget per trade, entries need trend confirmation, and every position carries a verified stop. Replace this text with how the strategy actually trades.',
  minInvestment: 100,
  maxInvestment: 25_000,
  durationDays: 30,
  // An indicative RANGE, never a single guaranteed figure.
  targetReturnMin: 4,
  targetReturnMax: 12,
  riskLevel: 'MEDIUM',
  performanceFee: 20,
  managementFee: 2,
  maxDrawdown: 25,
  isActive: true,
};

/**
 * Field-by-field legend for the example above: what each key means and the rule
 * the API enforces on it. Shown in the admin console beside the example so an
 * operator does not have to read the schema to fill the form in correctly.
 */
export const PLAN_FIELD_GUIDE: ReadonlyArray<{ field: keyof PlanInput; rule: string }> = [
  { field: 'name', rule: '3–120 characters. Shown to clients on the plan card.' },
  { field: 'description', rule: '10–2000 characters. Say how the strategy trades.' },
  { field: 'minInvestment', rule: 'USD, greater than 0. The smallest amount a client may deploy.' },
  { field: 'maxInvestment', rule: 'USD, greater than 0. Must exceed minInvestment.' },
  { field: 'durationDays', rule: 'Whole days, 1–3650. The cycle length.' },
  { field: 'targetReturnMin', rule: 'Percent, 0–100. Lower end of the indicative range.' },
  {
    field: 'targetReturnMax',
    rule: 'Percent, 0–100. Must be greater than or equal to targetReturnMin.',
  },
  { field: 'riskLevel', rule: 'LOW, MEDIUM or HIGH.' },
  { field: 'performanceFee', rule: 'Percent, 0–100, of profit.' },
  { field: 'managementFee', rule: 'Percent, 0–100, of deployed capital.' },
  {
    field: 'maxDrawdown',
    rule: 'Percent, greater than 0 and at most 100. The stop the engine enforces.',
  },
  { field: 'isActive', rule: 'Optional, defaults to true. false keeps the plan hidden.' },
];

/**
 * A named starting point for the create form.
 *
 * Four complete, valid shapes covering the risk/duration spectrum, so an operator
 * who has never written a plan can pick one, read how it is built, and adjust it
 * rather than stare at an empty form. They are EXAMPLES, not recommendations or
 * forecasts: every target return is an indicative range and is rendered with the
 * non-guarantee caveat. Each is asserted against `planInputSchema` by
 * `tests/plan-example.test.ts`, so none can drift from the contract.
 */
export interface PlanPreset {
  id: string;
  /** Short label for the preset button. */
  label: string;
  /** One line on who the shape is for. */
  summary: string;
  plan: PlanInput;
}

export const PLAN_PRESETS: readonly PlanPreset[] = [
  {
    id: 'conservative-income',
    label: 'Conservative Income · 90d',
    summary: 'Low risk — capital preservation, small size, tight drawdown stop.',
    plan: {
      name: 'Conservative Income 90',
      description:
        'Capital-preservation mandate over a 90-day cycle. Positions are sized small relative to deployed capital, entries need both trend and volatility confirmation, and the engine stops trading at the drawdown limit. Target returns are an indicative range, never a guarantee.',
      minInvestment: 500,
      maxInvestment: 50_000,
      durationDays: 90,
      targetReturnMin: 3,
      targetReturnMax: 7,
      riskLevel: 'LOW',
      performanceFee: 10,
      managementFee: 1,
      maxDrawdown: 12,
      isActive: true,
    },
  },
  {
    id: 'balanced-momentum',
    label: 'Balanced Momentum · 30d',
    summary: 'Mid risk, 30-day cycle — the balanced default shape.',
    plan: {
      name: 'Balanced Momentum 30',
      description:
        'Balanced 30-day cycle: positions are sized from a fixed risk budget per trade, entries need trend confirmation, and every position carries a verified stop. Target returns are an indicative range, never a guarantee.',
      minInvestment: 100,
      maxInvestment: 25_000,
      durationDays: 30,
      targetReturnMin: 4,
      targetReturnMax: 12,
      riskLevel: 'MEDIUM',
      performanceFee: 20,
      managementFee: 2,
      maxDrawdown: 25,
      isActive: true,
    },
  },
  {
    id: 'growth-trend',
    label: 'Growth Trend · 60d',
    summary: 'Mid risk, longer cycle, wider drawdown budget for trend following.',
    plan: {
      name: 'Growth Trend 60',
      description:
        'Higher-conviction trend following over a 60-day cycle. Larger position sizing with a wider per-trade risk budget and a wider drawdown stop; entries are filtered to established trends. Target returns are an indicative range, never a guarantee.',
      minInvestment: 250,
      maxInvestment: 100_000,
      durationDays: 60,
      targetReturnMin: 8,
      targetReturnMax: 20,
      riskLevel: 'MEDIUM',
      performanceFee: 25,
      managementFee: 2.5,
      maxDrawdown: 30,
      isActive: true,
    },
  },
  {
    id: 'aggressive-alpha',
    label: 'Aggressive Alpha · 14d',
    summary: 'High risk, short cycle, large swings — risk-tolerant capital only.',
    plan: {
      name: 'Aggressive Alpha 14',
      description:
        'High-risk, short 14-day cycle for risk-tolerant capital. Full risk budget per trade and a wide drawdown stop; expect large swings and meaningful loss potential. Target returns are an indicative range, never a guarantee.',
      minInvestment: 1_000,
      maxInvestment: 250_000,
      durationDays: 14,
      targetReturnMin: 12,
      targetReturnMax: 35,
      riskLevel: 'HIGH',
      performanceFee: 30,
      managementFee: 3,
      maxDrawdown: 40,
      isActive: true,
    },
  },
];
