import { z } from 'zod';
import { prisma } from './imported/lib/prisma';
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from './imported/server/modules/auth/password.service';

const DEFAULT_ADMIN_EMAIL = 'ceo@autopips.pro';

// Production-only, environment-configured bootstrap. This is not a public
// password-reset endpoint; credentials are supplied by deployment secrets.
export async function bootstrapProductionAdmin(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;

  const emailInput =
    process.env.ADMIN_SETUP_EMAIL?.trim() ||
    process.env.ADMIN_EMAIL?.trim() ||
    DEFAULT_ADMIN_EMAIL;
  const email = z.string().email().parse(emailInput).toLowerCase();
  const password = process.env.ADMIN_SETUP_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Admin setup requires ADMIN_SETUP_PASSWORD or ADMIN_PASSWORD.');
  }
  assertPasswordPolicy(password);

  await prisma.$transaction(async (tx) => {
    // Serialize initial provisioning even if multiple instances start together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(184927361)`;
    const existing = await tx.user.findUnique({ where: { email } });

    if (!existing) {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash: await hashPassword(password),
          role: 'SUPER_ADMIN',
          fullName: 'Administrator',
          country: '',
        },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'PRODUCTION_ADMIN_PROVISIONED',
          details: { source: 'environment_bootstrap', role: 'SUPER_ADMIN' },
        },
      });
      return;
    }

    const passwordIsCurrent = await verifyPassword(existing.passwordHash, password);
    if (existing.role === 'SUPER_ADMIN' && passwordIsCurrent) return;

    const data: { role: 'SUPER_ADMIN'; passwordHash?: string } = {
      role: 'SUPER_ADMIN',
    };
    if (!passwordIsCurrent) data.passwordHash = await hashPassword(password);

    await tx.user.update({ where: { id: existing.id }, data });
    await tx.auditLog.create({
      data: {
        userId: existing.id,
        action: 'PRODUCTION_ADMIN_SYNCED',
        details: {
          source: 'environment_bootstrap',
          role: 'SUPER_ADMIN',
          passwordUpdated: !passwordIsCurrent,
        },
      },
    });
  });
}