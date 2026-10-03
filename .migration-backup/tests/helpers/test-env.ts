/**
 * Test bootstrap — makes the repo `.env` visible to `process.env` BEFORE any
 * server module is imported.
 *
 * WHY THIS FILE EXISTS
 * Vitest does not load `.env` into `process.env` (it only exposes `VITE_*` vars
 * to `import.meta.env`). `@/lib/env.serverEnv()` and the Prisma singleton both
 * read `process.env` at call/construction time, so without this every test that
 * touches `@/lib/env` or `@/lib/prisma` would explode with "Invalid or missing
 * server environment variables".
 *
 * USAGE (critical): this module must be the FIRST import in a test file so its
 * side effect runs before `@/lib/prisma` / `@/lib/env` are evaluated:
 *
 *   import './helpers/test-env';
 *   import { prisma } from '@/lib/prisma';
 *
 * `process.loadEnvFile` (Node >= 20.12) does not override variables that are
 * already set, so a CI environment can point the suite at a different database
 * by exporting DATABASE_URL itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// NODE_ENV=test is what unlocks `computedDebug` on IPN verification results and
// keeps Prisma's query logging quiet. Vitest sets it already; assert it.
const mutableEnv = process.env as Record<string, string | undefined>;
if (mutableEnv.NODE_ENV !== 'test') mutableEnv.NODE_ENV = 'test';

const envPath = path.join(REPO_ROOT, '.env');

if (fs.existsSync(envPath)) {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (file: string) => void }).loadEnvFile;
  if (typeof loadEnvFile === 'function') {
    try {
      loadEnvFile.call(process, envPath);
    } catch (error) {
      console.warn(
        `[test-env] process.loadEnvFile(${envPath}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export const HAS_DATABASE_URL = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
export const HAS_IPN_SECRET =
  typeof process.env.NOWPAYMENTS_IPN_SECRET === 'string' && process.env.NOWPAYMENTS_IPN_SECRET.length > 0;
