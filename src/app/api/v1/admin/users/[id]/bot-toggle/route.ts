import { z } from 'zod';

import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { setUserBotEnabled } from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/users/:userId/bot-toggle
 *
 * `{ is_enabled: false }` stops the strategy engine from opening new positions
 * for one client; `true` lets it resume.
 *
 * The per-user control IS the investment status in this platform: an investment
 * is the unit the engine allocates to, so pausing it is precisely "this user's
 * bot is off". Only ACTIVE <-> PAUSED rows are touched — a MATURED, CLOSED or
 * CANCELLED investment has already settled and an operator toggle must never
 * re-open it (the service reports how many rows it skipped for that reason).
 *
 * Closing positions the client already holds is a separate, deliberate action:
 * this route does not liquidate anything.
 */
const bodySchema = z
  .object({
    is_enabled: z.boolean(),
  })
  .strict();

export const POST = handler(async (request: Request, context: { params: { id: string } }) => {
  const session = await requireAdmin();

  const body = bodySchema.parse(await readJson(request));

  const result = await setUserBotEnabled({
    userId: context.params.id,
    enabled: body.is_enabled,
    actorId: session.userId,
    ip: clientIp(request),
  });

  return ok({
    userId: context.params.id,
    is_enabled: body.is_enabled,
    investmentsChanged: result.changed,
    investmentsSkipped: result.skipped,
  });
});
