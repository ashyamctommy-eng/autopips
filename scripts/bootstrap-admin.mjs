#!/usr/bin/env node
/**
 * Ensure a single ADMIN account exists.
 *
 * WHY: a fresh database has no users, and the public registration form cannot
 * create an administrator — it only ever writes CLIENT rows. Without this, the
 * back office is unreachable on a new deployment (the only way in was a manual
 * `UPDATE "User" SET role='ADMIN'` in a SQL console).
 *
 * Driven entirely by environment variables, so no credential is ever committed:
 *
 *   BOOTSTRAP_ADMIN_EMAIL     e.g. ceo@autopips.pro
 *   BOOTSTRAP_ADMIN_PASSWORD  the initial password
 *   BOOTSTRAP_ADMIN_NAME      optional, default "Platform Administrator"
 *   BOOTSTRAP_ADMIN_COUNTRY   optional, default "KE"
 *
 * IDEMPOTENT BY DESIGN:
 *   • no such user      → create them, ADMIN + kycStatus APPROVED
 *   • user exists       → promote to ADMIN/APPROVED only; the PASSWORD IS LEFT
 *                         ALONE, so a password you change in the admin console
 *                         is not silently reverted on the next deploy/restart.
 *   • no env vars set   → no-op, exit 0
 *
 * Plain .mjs on purpose: the runtime image prunes devDependencies, so there is
 * no tsx/TypeScript available at boot. Argon2 parameters are duplicated from
 * src/server/modules/auth/password.service.ts and must stay in sync with it.
 *
 * Run it by hand any time:  npm run bootstrap:admin
 */

import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

// Must match ARGON2_OPTIONS in src/server/modules/auth/password.service.ts.
const ARGON2_ID = 2;
const ARGON2_OPTIONS = {
  algorithm: ARGON2_ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
const fullName = (process.env.BOOTSTRAP_ADMIN_NAME ?? '').trim() || 'Platform Administrator';
const country = (process.env.BOOTSTRAP_ADMIN_COUNTRY ?? '').trim() || 'KE';

if (!email || !password) {
  console.log('[bootstrap-admin] BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set — nothing to do.');
  process.exit(0);
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`[bootstrap-admin] refusing to run: "${email}" is not a valid email address.`);
  process.exit(1);
}

// A hard floor only. The full policy in password.service.ts (12+ chars with
// upper/lower/number/symbol) is enforced by the register and change-password
// routes; a bootstrap value is accepted as long as it is not trivially short.
if (password.length < 8) {
  console.error('[bootstrap-admin] refusing to run: BOOTSTRAP_ADMIN_PASSWORD is shorter than 8 characters.');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    const needsPromotion = existing.role !== 'ADMIN' || existing.kycStatus !== 'APPROVED';
    if (!needsPromotion) {
      console.log(`[bootstrap-admin] ${email} is already an approved ADMIN — nothing to do.`);
    } else {
      await prisma.user.update({
        where: { email },
        data: { role: 'ADMIN', kycStatus: 'APPROVED' },
      });
      console.log(`[bootstrap-admin] promoted existing account ${email} to ADMIN (password untouched).`);
    }
  } else {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hash(password, ARGON2_OPTIONS),
        fullName,
        country,
        role: 'ADMIN',
        kycStatus: 'APPROVED',
        is2FAEnabled: false,
      },
    });
    console.log(`[bootstrap-admin] created ADMIN ${email}.`);
    console.log(
      '[bootstrap-admin] NEXT: sign in, change this password in the admin console ' +
        '(Profile & security), then remove BOOTSTRAP_ADMIN_PASSWORD from the service variables.',
    );
  }
} catch (err) {
  console.error('[bootstrap-admin] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
