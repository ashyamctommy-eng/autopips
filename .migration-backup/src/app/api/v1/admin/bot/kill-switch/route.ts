import { z } from 'zod';

import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { setBotEnabled } from '@/server/modules/bot/bot-control.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/bot/kill-switch
 *
 * `{ active: false, reason }` stops trading everywhere. `{ active: true }`
 * releases it.
 *
 * What "everywhere" means in this architecture: the state is written to Redis,
 * which the order path reads UNCONDITIONALLY on every order — no cache, so a
 * refusal cannot be delayed by a TTL in another process — and the durable
 * `PlatformSetting` row is written too, so a Redis flush cannot silently re-arm
 * a stopped bot. The change is audited with the operator's reason, and pushed to
 * the admin room so every open console updates at once.
 *
 * Stopping REQUIRES a reason (enforced by the service): an unexplained halt on a
 * money platform is its own incident. Releasing does not, and clears the stored
 * reason.
 *
 * Independent of the broker: this route works when the broker connection is the
 * thing that is broken, which is when an operator most needs it.
 */
const bodySchema = z
  .object({
    active: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const POST = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = bodySchema.parse(await readJson(request));

  const state = await setBotEnabled({
    enabled: body.active,
    reason: body.reason ?? null,
    actor: { id: session.userId, email: session.email },
    ip: clientIp(request),
  });

  return ok(state);
});
