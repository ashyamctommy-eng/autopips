import { z } from 'zod';
import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import {
  ADMIN_USER_ROLES,
  getAdminUser,
  updateUserProfile,
  updateUserRole,
  type AdminUserRow,
} from '@/server/modules/admin/admin.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/admin/users/:id
 *
 * Admin-only updates of a user's role and the non-sensitive profile fields.
 *
 * WHAT THIS ROUTE DELIBERATELY CANNOT TOUCH:
 *   - `email`             — the login identifier / KYC anchor.
 *   - `kycStatus`         — identity state moves ONLY through
 *                           POST /api/v1/admin/kyc/:id/decision, which keeps a
 *                           reviewed decision and its audit row together.
 *   - `passwordHash`      — a credential.
 *   - `twoFactorSecret`   — a second factor is only ever enrolled by its owner.
 * Those keys are rejected up front with a 400 (and `.strict()` rejects anything
 * else unknown), so a client mistake can never be a silent field write.
 *
 * Demoting the last remaining ADMIN is refused by the service (409).
 */

const bodySchema = z
  .object({
    role: z.enum(ADMIN_USER_ROLES).optional(),
    fullName: z.string().trim().min(2).max(120).optional(),
    country: z.string().trim().min(2).max(64).optional(),
    phone: z
      .string()
      .trim()
      .min(4, 'Phone must be at least 4 characters.')
      .max(32, 'Phone must be at most 32 characters.')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update.',
  });

/** Identity/credential fields the admin API must never write. */
const FORBIDDEN_FIELDS = ['email', 'kycStatus', 'passwordHash', 'twoFactorSecret'] as const;

export const PATCH = handler(
  async (request: Request, context: { params: { id: string } }) => {
    const session = await requireAdmin();
    const targetUserId = context.params.id;
    const raw = await readJson(request);

    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const present = FORBIDDEN_FIELDS.filter((field) => field in raw);
      if (present.length > 0) {
        throw ApiError.badRequest(
          `${present.join(', ')} cannot be changed through this route. ` +
            'Identity state changes only via the KYC decision endpoint; credentials are never admin-writable.',
        );
      }
    }

    const body = bodySchema.parse(raw);
    const ip = clientIp(request);

    const changedFields: string[] = [];
    let user: AdminUserRow | null = null;

    if (body.role !== undefined) {
      const result = await updateUserRole({
        adminUserId: session.userId,
        targetUserId,
        role: body.role,
        ip,
      });
      user = result.user;
      changedFields.push(...result.changedFields);
    }

    if (body.fullName !== undefined || body.country !== undefined || body.phone !== undefined) {
      const result = await updateUserProfile({
        adminUserId: session.userId,
        targetUserId,
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...('phone' in body ? { phone: body.phone ?? null } : {}),
        ip,
      });
      user = result.user;
      changedFields.push(...result.changedFields);
    }

    // `bodySchema` guarantees at least one field, so this fallback is only a
    // type-narrowing read (it also 404s an unknown id).
    return ok({ user: user ?? (await getAdminUser(targetUserId)), changedFields });
  },
);
