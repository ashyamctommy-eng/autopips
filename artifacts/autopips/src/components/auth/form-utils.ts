/**
 * Small client-side input guards for the auth forms.
 *
 * These are *pre-flight* checks only: they catch the obvious typos (an empty
 * box, a missing `@`) so the user does not wait for a round trip to find out.
 * The server validates the same input again — zod's `.email()` in
 * `src/app/api/v1/auth/{login,register}/route.ts` is the authority, and any 422
 * it returns is mapped back onto the fields by `pickFieldIssues`.
 */

/**
 * Deliberately loose: one `@`, a dot in the domain, no whitespace. It accepts a
 * few addresses zod would reject (and vice versa) — that is fine, because the
 * server's answer always wins.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** API field limits, mirrored for preview only (`min`/`max` in the route schema). */
export const FIELD_LIMITS = {
  fullName: { min: 2, max: 120 },
  email: { max: 254 },
  phone: { min: 6, max: 32 },
  country: { min: 2, max: 56 },
  password: { min: 12, max: 256 },
} as const;
