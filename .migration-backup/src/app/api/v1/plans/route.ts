import { handler, ok } from '@/lib/http';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';
import { listActivePlans } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/plans
 *
 * Public list of ACTIVE trading plans — the same payload the marketing site and
 * the dashboard plan-picker consume.
 *
 * Each plan carries `targetReturnLabel` (mandatory alongside any target figure)
 * and `stats`, which is `null` until the plan has a closed-trade track record.
 * The envelope repeats the full non-guarantee disclaimer.
 */
export const GET = handler(async () => {
  const plans = await listActivePlans();

  return ok(plans, { disclaimer: TARGET_RETURN_DISCLAIMER });
});
