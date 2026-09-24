import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAudit, recordAuditSafe } from '@/server/modules/audit/audit.service';
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '@/server/modules/auth/password.service';
import { requireSessionUser } from '@/server/modules/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/password — change your own password.
 *
 * Available to EVERY signed-in account (client and admin alike): the bootstrap
 * admin created at deploy time gets a password from an environment variable, and
 * the only responsible thing to do with such a password is replace it here.
 *
 * The CURRENT password is required even though the caller already holds a live
 * session. A session can outlive an unlocked laptop; proof of the existing
 * secret is what stops a stolen cookie from becoming a permanent account
 * takeover.
 *
 * The new password is checked against the same policy the registration route
 * enforces (src/server/modules/auth/password.service.ts), and the attempt is
 * rate-limited per account so this route cannot be used to grind a password.
 *
 * NOT DONE HERE (deliberate, and documented in the response of the reviewer):
 * revoking the account's OTHER sessions. Refresh tokens are stored per session id
 * in Redis and there is no per-user session index to enumerate, so a proper
 * implementation needs a `userId` index or a password-changed-at claim check.
 * Access tokens are short-lived (ACCESS_TOKEN_TTL, 15 min by default), which
 * bounds the exposure in the meantime.
 */
const bodySchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

/** 5 attempts per 15 minutes per account. */
const CHANGE_LIMIT = { limit: 5, windowSeconds: 900 } as const;

export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();
  const ip = clientIp(request);

  const limit = await rateLimit(`password:${user.id}`, CHANGE_LIMIT.limit, CHANGE_LIMIT.windowSeconds);
  if (!limit.allowed) {
    throw ApiError.rateLimited(
      `Too many password attempts. Try again in ${limit.resetSeconds} seconds.`,
    );
  }

  const body = bodySchema.parse(await readJson(request));

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!row) throw ApiError.unauthorized();

  if (!(await verifyPassword(row.passwordHash, body.currentPassword))) {
    await recordAuditSafe({
      action: AUDIT.AUTH_PASSWORD_CHANGE_FAILED,
      userId: user.id,
      ipAddress: ip,
      details: { reason: 'bad_current_password' },
    });
    throw ApiError.badRequest('Current password is incorrect.');
  }

  // assertPasswordPolicy throws a plain Error; a raw Error would surface as a 500
  // through handler(), so it is translated into a 400 here — same as register.
  try {
    assertPasswordPolicy(body.newPassword);
  } catch (err) {
    throw ApiError.badRequest(
      err instanceof Error ? err.message : 'Password does not meet the password policy.',
    );
  }

  if (await verifyPassword(row.passwordHash, body.newPassword)) {
    throw ApiError.badRequest('The new password must be different from the current one.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(body.newPassword) },
  });

  await recordAudit({
    action: AUDIT.AUTH_PASSWORD_CHANGED,
    userId: user.id,
    ipAddress: ip,
    // No password material, not even a hash prefix.
    details: { method: 'password', self: true },
  });

  return ok({ changed: true });
});
