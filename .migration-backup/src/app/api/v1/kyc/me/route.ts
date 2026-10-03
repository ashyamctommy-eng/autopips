import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { getMyKyc } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/kyc/me
 *
 * The caller's own KYC profile. `data` is null (not a 404) when nothing has
 * been submitted yet, so the UI can render the empty state without special
 * casing. ID numbers are masked and object keys are never included.
 */
export const GET = handler(async () => {
  const user = await requireSessionUser();
  const profile = await getMyKyc(user.id);

  return ok(profile);
});
