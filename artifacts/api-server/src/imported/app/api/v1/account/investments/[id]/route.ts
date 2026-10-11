import { z } from 'zod';

import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { getInvestmentForUser } from '@/server/modules/account/account.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/v1/account/investments/:id
 *
 * The caller's OWN investment (404 for anyone else's) plus the book of
 * internally-executed positions the bot engine opened against its deployed
 * capital, and a derived `yieldPct`.
 *
 * The positions are a DRILL-DOWN of the investment, not a second money source —
 * the ledger counts the Investment's own columns (the linked positions are
 * excluded from the standalone position aggregates), so the totals here and in
 * the wallet can never disagree.
 */
export const GET = handler(async (_request: Request, context: { params: { id: string } }) => {
  const user = await requireSessionUser();
  const { id } = paramsSchema.parse(context.params);

  const detail = await getInvestmentForUser(user.id, id);
  return ok(detail);
});
