import { hash, verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';

/**
 * Password hashing — Argon2id with OWASP-recommended parameters.
 *
 * @node-rs/argon2 is used instead of the `argon2` native addon so the image
 * builds without a node-gyp toolchain; it implements the same Argon2id and
 * produces standard PHC-format hashes ($argon2id$v=19$m=...).
 */

/**
 * Argon2id = 2 in @node-rs/argon2's `Algorithm` enum. The numeric value is
 * inlined deliberately: the package declares `Algorithm` as an *ambient const
 * enum*, and this project compiles with `isolatedModules: true`, which forbids
 * accessing ambient const enum members by name (TS2748).
 */
const ARGON2_ID = 2;

// OWASP 2024 baseline: m=19456 KiB (19 MiB), t=2, p=1.
const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2_ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Minimum acceptable password policy for a platform holding client capital. */
export const PASSWORD_POLICY = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
} as const;

export function assertPasswordPolicy(password: string): void {
  const problems: string[] = [];
  if (password.length < PASSWORD_POLICY.minLength) {
    problems.push(`at least ${PASSWORD_POLICY.minLength} characters`);
  }
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  if (problems.length) {
    throw new Error(`Password must contain ${problems.join(', ')}.`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hashString: string, password: string): Promise<boolean> {
  try {
    return await verify(hashString, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verification when the account does not
 * exist, so response timing cannot be used to enumerate registered emails.
 *
 * The reference hash is generated once, lazily, from a real Argon2id pass — a
 * hard-coded fake PHC string would either be rejected instantly (no CPU burned,
 * defeating the purpose) or fail to parse.
 */
let timingEqualizerHash: Promise<string> | null = null;

function getTimingEqualizerHash(): Promise<string> {
  timingEqualizerHash ??= hash('autopips-timing-equalizer', ARGON2_OPTIONS);
  return timingEqualizerHash;
}

export async function dummyVerify(password = 'not-a-real-password'): Promise<void> {
  try {
    await verify(await getTimingEqualizerHash(), password, ARGON2_OPTIONS);
  } catch {
    /* expected: always fails, we only want the CPU cost */
  }
}
