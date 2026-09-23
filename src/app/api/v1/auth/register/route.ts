import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { assertPasswordPolicy, hashPassword } from '@/server/modules/auth/password.service';
import { toSessionUser } from '@/server/modules/auth/session-issue';
import type { User } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(256),
  fullName: z.string().trim().min(2).max(120),
  country: z.string().trim().min(2).max(56),
  phone: z.string().trim().min(6).max(32).optional(),
});

/** 5 registrations per IP per 15 minutes. */
const REGISTER_LIMIT = { limit: 5, windowSeconds: 900 } as const;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Inserts the account, translating the unique-email race into a 409. Two
 * concurrent sign-ups for one address must not produce a 500.
 */
async function createAccount(input: {
  email: string;
  passwordHash: string;
  fullName: string;
  country: string;
  phone: string | null;
}): Promise<User> {
  try {
    return await prisma.user.create({
      data: {
        ...input,
        role: 'CLIENT',
        kycStatus: 'NOT_SUBMITTED',
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('An account with that email already exists.');
    }
    throw err;
  }
}

/**
 * POST /api/v1/auth/register
 *
 * Creates a CLIENT account in `NOT_SUBMITTED` KYC state. Registration does NOT
 * log the user in: no cookie is minted here, so a newly created account cannot
 * act until it has authenticated through /auth/login (and completed 2FA if the
 * account later enables it). Deposits, investments and withdrawals all require
 * an APPROVED KYC record regardless.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);

  const limited = await rateLimit(`register:ip:${ip ?? 'unknown'}`, REGISTER_LIMIT.limit, REGISTER_LIMIT.windowSeconds);
  if (!limited.allowed) {
    throw ApiError.rateLimited(
      `Too many sign-up attempts. Try again in ${limited.resetSeconds}s.`,
    );
  }

  const body = bodySchema.parse(await readJson(request));
  const email = body.email.toLowerCase().trim();

  // assertPasswordPolicy throws a plain Error; a raw Error would surface as a
  // 500 through handler(), so it is translated into a 400 here.
  try {
    assertPasswordPolicy(body.password);
  } catch (err) {
    throw ApiError.badRequest(
      err instanceof Error ? err.message : 'Password does not meet the password policy.',
    );
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    // Same message whether or not the caller owns the address: the enumeration
    // signal is unavoidable here (the address is taken), but we have rate-limited
    // the endpoint so it cannot be swept at scale.
    throw ApiError.conflict('An account with that email already exists.');
  }

  const passwordHash = await hashPassword(body.password);

  const user = await createAccount({
    email,
    passwordHash,
    fullName: body.fullName,
    country: body.country,
    phone: body.phone ?? null,
  });

  await recordAuditSafe({
    action: AUDIT.AUTH_REGISTERED,
    userId: user.id,
    details: { email: user.email, country: user.country },
    ipAddress: ip,
  });

  return ok(toSessionUser(user), { status: 201 });
});
