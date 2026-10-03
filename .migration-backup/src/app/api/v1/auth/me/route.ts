import { handler, ok } from '@/lib/http';
import { getSessionUser } from '@/server/modules/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/me
 *
 * Returns the SessionUser, or `null` with a 200 when nobody is signed in.
 *
 * Deliberately NOT a 401. This endpoint is what the UI calls on boot to decide
 * whether to render the dashboard or the marketing page, and a signed-out
 * visitor is a normal state, not an error — treating it as one would put a red
 * toast on every logged-out page load.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  return ok(user);
});
