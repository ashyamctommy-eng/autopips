import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { AUDIT, recordAuditSafe } from '@/server/modules/audit/audit.service';
import { assertPasswordPolicy, hashPassword } from '@/server/modules/auth/password.service';
import { toSessionUser } from '@/server/modules/auth/session-issue';
import { recordCurrentConsents } from '@/server/modules/legal/legal.service';
import type { User } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(256),
  fullName: z.string().trim().min(2).max(120),
  country: z.string().trim().min(2).max(56),
  phone: z.string().trim().min(6).max(32).optional(),
  // Explicit affirmative acceptance of each instrument. `refine` (not
  // `z.literal(true)`) so a false or missing value produces the field message
  // the form shows, and so there is no accidental "undefined passes" path.
  acceptedTerms: z.boolean().refine((value) => value === true, {
    message: 'You must accept the Terms of Service.',
  }),
  acceptedPrivacy: z.boolean().refine((value) => value === true, {
    message: 'You must accept the Privacy Policy.',
  }),
  acceptedRiskDisclosure: z.boolean().refine((value) => value === true, {
    message: 'You must acknowledge the Risk Disclosure.',
  }),
});

/** 5 registrations per IP per 15 minutes. */
const REGISTER_LIMIT = { limit: 5, windowSeconds: 900 } as const;

/**
 * True only for a UNIQUE violation on `User.email` — not for any other P2002.
 *
 * The registration transaction now also writes `LegalDocument` and `UserConsent`
 * rows; a collision on one of those must not be reported to the user as "that
 * email is already registered".
 */
function isEmailUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code !== 'P2002') return false;

  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.map(String).some((field) => field.toLowerCase().includes('email'));
  }
  if (typeof target === 'string') return target.toLowerCase().includes('email');

  // Prisma reports the constrained field(s) for Postgres. If it is somehow
  // absent, do NOT guess "email taken" — surface the real error instead.
  return false;
}

/**
 * Inserts the account, translating the unique-email race into a 409. Two
 * concurrent sign-ups for one address must not produce a 500.
 */
interface CreateAccountContext {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Inserts the account AND its legal-consent records in ONE transaction, then
 * translates the unique-email race into a 409. Two concurrent sign-ups for one
 * address must not produce a 500; more importantly, a failed consent write
 * rolls the account back, so no account can exist without a record of what it
 * accepted.
 */
async function createAccount(
  input: {
    email: string;
    passwordHash: string;
    fullName: string;
    country: string;
    phone: string | null;
  },
  context: CreateAccountContext,
): Promise<User> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          ...input,
          role: 'CLIENT',
          kycStatus: 'NOT_SUBMITTED',
        },
      });

      await recordCurrentConsents(
        tx,
        {
          userId: user.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          method: 'REGISTRATION',
        },
        // A brand-new account must have ALL consent rows or none: an incomplete
        // write aborts the transaction, so no account can exist without a record
        // of what it accepted.
        { requireAll: true },
      );

      return user;
    });
  } catch (err) {
    if (isEmailUniqueViolation(err)) {
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

  const user = await createAccount(
    {
      email,
      passwordHash,
      fullName: body.fullName,
      country: body.country,
      phone: body.phone ?? null,
    },
    {
      ipAddress: ip,
      userAgent: request.headers.get('user-agent'),
    },
  );

  await recordAuditSafe({
    action: AUDIT.AUTH_REGISTERED,
    userId: user.id,
    details: {
      email: user.email,
      country: user.country,
      // The consent rows are the evidence; naming the acceptance here keeps the
      // security trail self-contained.
      legalConsents: ['TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'RISK_DISCLOSURE'],
      consentMethod: 'REGISTRATION',
    },
    ipAddress: ip,
  });

  return ok(toSessionUser(user), { status: 201 });
});
