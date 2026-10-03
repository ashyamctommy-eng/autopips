import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { submitKyc } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/kyc/submit
 *
 * Attaches the personal details to the object keys produced by
 * /api/v1/kyc/upload, upserts the KycProfile, moves the user to PENDING and
 * writes KYC_SUBMITTED / KYC_RESUBMITTED to the audit log.
 */
export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const body = await readJson(request);

  const profile = await submitKyc(user.id, body, clientIp(request));

  return ok(profile);
});
