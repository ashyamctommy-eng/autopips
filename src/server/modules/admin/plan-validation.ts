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
