import { z } from 'zod';

import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { setRiskControls } from '@/server/modules/bot/bot-control.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/admin/bot/config
 *
 * The platform-wide trading rules, adjustable without a redeploy (the settings
 * layer is read per request where it matters — see bot-control.service.ts).
 *
 * Field names follow the operating brief; each maps onto one platform setting,
 * and validation belongs to the setting (a negative stake cap or a malformed
 * symbol is rejected with a message written for an operator).
 *
 *   max_stake_limit        → risk.max_stake_usd          (0 = no cap)
 *   daily_loss_limit       → risk.daily_loss_limit_usd   (0 = no limit)
 *   min_payout_percentage  → risk.min_payout_percentage  (0 = no floor)
 *   risk_per_trade_pct     → risk.risk_per_trade_pct     (0 = refuse every
 *                            stake-sized order; the stake IS the max loss on a
 *                            multiplier contract, so this is the per-order risk
 *                            budget and the notional is derived from it)
 *   allowed_symbols        → risk.allowed_symbols        ([] = every symbol)
 *
 * `allowed_symbols: []` CLEARS the allow-list (no restriction) — an empty list
 * is a decision, not a missing value, so it is honoured explicitly.
 */
const bodySchema = z
  .object({
    max_stake_limit: z.number().nonnegative().optional(),
    daily_loss_limit: z.number().nonnegative().optional(),
    min_payout_percentage: z.number().nonnegative().max(100_000).optional(),
    risk_per_trade_pct: z.number().nonnegative().max(100).optional(),
    allowed_symbols: z.array(z.string().trim().min(1).max(32)).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one setting to update.',
  });

export const PATCH = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = bodySchema.parse(await readJson(request));
  const actor = { id: session.userId, email: session.email };

  const updates: Array<{ key: string; value: string | null }> = [];
  if (body.max_stake_limit !== undefined) {
    updates.push({ key: 'risk.max_stake_usd', value: String(body.max_stake_limit) });
  }
  if (body.daily_loss_limit !== undefined) {
    updates.push({ key: 'risk.daily_loss_limit_usd', value: String(body.daily_loss_limit) });
  }
  if (body.min_payout_percentage !== undefined) {
    updates.push({ key: 'risk.min_payout_percentage', value: String(body.min_payout_percentage) });
  }
  if (body.risk_per_trade_pct !== undefined) {
    updates.push({ key: 'risk.risk_per_trade_pct', value: String(body.risk_per_trade_pct) });
  }
  if (body.allowed_symbols !== undefined) {
    updates.push({
      key: 'risk.allowed_symbols',
      // An empty array clears the row: "no restriction", which is different from
      // "a restriction nobody has set".
      value: body.allowed_symbols.length > 0 ? body.allowed_symbols.join(',') : null,
    });
  }

  void clientIp(request);
  const state = await setRiskControls(updates, actor);

  return ok(state);
});
