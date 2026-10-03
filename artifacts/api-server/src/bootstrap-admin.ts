import { z } from 'zod';
import { prisma } from './imported/lib/prisma';
import { assertPasswordPolicy, hashPassword } from './imported/server/modules/auth/password.service';

// An explicit production-only setup, not a password reset or a public endpoint.
// The audit marker prevents a later restart from recreating a deleted account.
export async function bootstrapProductionAdmin(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || !process.env.ADMIN_SETUP_EMAIL) return;
  const email = z.string().email().parse(process.env.ADMIN_SETUP_EMAIL).toLowerCase();
  await prisma.$transaction(async (tx) => {
    // Serialize initial provisioning even if multiple instances start together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(184927361)`;
    const owner = await tx.user.findUnique({ where: { email } });
    const upgraded = await tx.auditLog.findFirst({ where: { action: 'OWNER_SUPER_ADMIN_PROVISIONED' } });
    if (!upgraded && owner?.role === 'ADMIN') {
      await tx.user.update({ where: { id: owner.id }, data: { role: 'SUPER_ADMIN' } });
      await tx.auditLog.create({ data: { userId: owner.id, action: 'OWNER_SUPER_ADMIN_PROVISIONED', details: { source: 'owner_requested_setup' } } });
      return;
    }
    if (await tx.auditLog.findFirst({ where: { action: 'PRODUCTION_ADMIN_PROVISIONED' } })) return;
    if (await tx.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } })) return;
    if (await tx.user.findUnique({ where: { email } })) {
      throw new Error('Admin setup refused: the requested account already exists.');
    }
    const password = process.env.ADMIN_SETUP_PASSWORD;
    if (!password) throw new Error('Admin setup requires ADMIN_SETUP_PASSWORD.');
    assertPasswordPolicy(password);
    const user = await tx.user.create({
      data: { email, passwordHash: await hashPassword(password), role: 'SUPER_ADMIN', fullName: 'Administrator', country: '' },
    });
    await tx.auditLog.create({
      data: { userId: user.id, action: 'PRODUCTION_ADMIN_PROVISIONED', details: { source: 'owner_requested_setup', role: 'SUPER_ADMIN' } },
    });
  });
}