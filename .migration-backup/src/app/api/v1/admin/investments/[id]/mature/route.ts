import { z } from 'zod';

import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { closeInvestmentManually } from '@/server/modules/account/maturity.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/investments/:id/mature
 *
 * ADMIN-only manual close of one investment, releasing its capital back to the
 * client's idle (withdrawable) balance.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE AUTOMATIC SWEEP: the worker matures
 * investments when their plan term elapses, but an operator sometimes has to
 * close early for a documented reason — a client request, a broker migration, a
 * fraud hold. This route does that through the SAME service function the sweep
 * uses, so the accounting guard, the compare-and-swap and the capital-preserving
 * patch cannot drift:
 *
 *   * a reason is REQUIRED and is written to the append-only AuditLog;
 *   * the audit action is INVESTMENT_CLOSED with `trigger: 'MANUAL'`, the reason
 *     and the operator named, so the trail never reads as an automatic maturity;
 *   * the close is REFUSED when the investment does not exist, is already
 *     terminal (MATURED/CLOSED/CANCELLED), or still has an OPEN position — an
 *     open position would keep its unrealized P/L counted against capital that is
 *     no longer deployed.
 *
 * The operator-facing message on each refusal is the one the service raises, so
 * the console can show why the button did nothing.
 */
const bodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, 'Give a reason — it is kept in the audit trail.')
      .max(280, 'Reason must be at most 280 characters.'),
  })
  .strict();

export const POST = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();

    const body = bodySchema.parse(await readJson(request));

    const result = await closeInvestmentManually({
      investmentId: context.params.id,
      reason: body.reason,
      actorUserId: session.userId,
      actorEmail: session.email,
      ip: clientIp(request),
    });

    return ok(result);
  },
);
