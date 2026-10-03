import { z } from 'zod';

import { clientIp, handler, ok, readJson } from '@/lib/http';
import { AUDIT, recordAudit } from '@/server/modules/audit/audit.service';
import { requireAdmin } from '@/server/modules/auth/session';
import { listAdminSettings, saveAdminSetting } from '@/server/modules/settings/settings.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/settings
 *   Every editable platform setting with its EFFECTIVE source ('console' |
 *   'environment' | 'unset'). Secret values are returned masked, never in clear.
 *
 * PUT /api/v1/admin/settings
 *   Set one setting, or clear it by sending `value: null` / `""` — which reverts
 *   that key to its environment variable. One key per request so two operators
 *   editing different keys cannot clobber each other.
 *
 * ADMIN only. These values include the payment provider credentials, so the same
 * rule as Admin → Brokers applies: a TRADING_MANAGER can see the platform, not
 * the keys to its money rails.
 *
 * Audit: one ADMIN_SETTINGS_UPDATED row per change, recording the KEY, the
 * ACTION and who did it — never the value (it would put a live API key in the
 * append-only log, which is the one place a secret must never end up).
 */
export const GET = handler(async () => {
  await requireAdmin();
  return ok(await listAdminSettings());
});

const bodySchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().max(2048).nullable().optional(),
});

export const PUT = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = bodySchema.parse(await readJson(request));

  const result = await saveAdminSetting(body.key, body.value ?? null, {
    id: session.userId,
    email: session.email,
  });

  await recordAudit({
    action: AUDIT.ADMIN_SETTINGS_UPDATED,
    userId: session.userId,
    ipAddress: clientIp(request),
    details: { key: result.key, action: result.action },
  });

  // Return the refreshed list so the console reflects the new source without a
  // second round trip.
  return ok({ ...result, settings: await listAdminSettings() });
});
