import { prisma } from '@/lib/prisma';
import { ApiError, handler, ok } from '@/lib/http';
import { requireSession } from '@/server/modules/auth/session';
import { generateTwoFactorSecret } from '@/server/modules/auth/twofactor.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/2fa/setup
 *
 * Returns a PROVISIONING secret plus the QR code for it, for an authenticated
 * session only.
 *
 * The secret is not persisted by this route: it exists in the response and
 * nowhere else until /api/v1/auth/2fa/enable receives it back together with a
 * code the user's authenticator generated from it. That is what stops a
 * half-finished enrolment from locking an account out.
 *
 * This is the one endpoint in the platform that returns a secret in a response
 * body, and it is the reason the module comment in twofactor.service.ts is
 * explicit about it: nothing else may echo `twoFactorSecret`.
 */
export const GET = handler(async () => {
  const session = await requireSession();

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, is2FAEnabled: true },
  });
  if (!user) throw ApiError.unauthorized();

  if (user.is2FAEnabled) {
    throw ApiError.conflict(
      'Two-factor authentication is already enabled. Disable it before enrolling a new device.',
    );
  }

  const provisioning = await generateTwoFactorSecret({ id: user.id, email: user.email });
  return ok(provisioning);
});
