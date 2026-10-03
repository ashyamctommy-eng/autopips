import { PrismaClient } from '@prisma/client';

/**
 * Prisma singleton.
 *
 * Next.js dev mode hot-reloads modules; without the global cache each reload
 * opens a new connection pool and exhausts Postgres.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { Prisma } from '@prisma/client';
