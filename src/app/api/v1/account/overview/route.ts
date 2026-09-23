import { handler, ok } from '@/lib/http';
import { TARGET_RETURN_DISCLAIMER } from '@/lib/contracts';
import { requireSessionUser } from '@/server/modules/auth/session';
import { getOverview } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/account/overview
 *
 * The client's equity summary, computed from persisted ledger rows by
 * `getAccountSnapshot()`. The `formula` field carries the equity formula the
 * number was produced with, and the envelope repeats the non-guarantee
 * disclaimer because this payload contains indicative return figures.
 */
export const GET = handler(async () => {
  const user = await requireSessionUser();
  const overview = await getOverview(user.id);

  return ok(overview, { disclaimer: TARGET_RETURN_DISCLAIMER });
});
