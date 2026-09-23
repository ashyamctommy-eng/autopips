/**
 * Client-safe mirror of the server password policy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The authoritative policy lives in `src/server/modules/auth/password.service.ts`
 * (`PASSWORD_POLICY`) and is enforced by `assertPasswordPolicy`. That module
 * imports `@node-rs/argon2`, a native hashing library, so importing it from a
 * component would drag server-only code (and a native module) into the browser
 * bundle. The rule shape is therefore mirrored here, in plain TypeScript, so the
 * registration form can give live feedback.
 *
 * THE SERVER REMAINS THE AUTHORITY. This mirror is a courtesy that saves the
 * user a round trip; it is not a security control, and a mismatch between the
 * two must never be resolved in favour of this file. `POST /api/v1/auth/register`
 * re-validates with `assertPasswordPolicy` (and zod's `min(12).max(256)`) and
 * returns 400/422 for anything this file would have let through.
 *
 * Keep in sync with `password.service.ts`:
 *   minLength: 12, uppercase, lowercase, number, symbol.
 */

export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 256,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
} as const;

export type PasswordRequirementId =
  | 'length'
  | 'uppercase'
  | 'lowercase'
  | 'number'
  | 'symbol';

export interface PasswordRequirement {
  id: PasswordRequirementId;
  /** Shown in the live checklist. */
  label: string;
  /**
   * The unmet requirement as a noun phrase, worded to match the server's
   * `assertPasswordPolicy` complaints so the two messages cannot diverge.
   */
  problem: string;
  /** The same test `assertPasswordPolicy` performs on the server. */
  test: (password: string) => boolean;
}

/**
 * Order matters: length first, then character classes, to match the order the
 * server lists its complaints in.
 */
export const PASSWORD_REQUIREMENTS: readonly PasswordRequirement[] = [
  {
    id: 'length',
    label: `At least ${PASSWORD_POLICY.minLength} characters`,
    problem: `at least ${PASSWORD_POLICY.minLength} characters`,
    test: (password) => password.length >= PASSWORD_POLICY.minLength,
  },
  {
    id: 'uppercase',
    label: 'An uppercase letter (A–Z)',
    problem: 'an uppercase letter',
    test: (password) => /[A-Z]/.test(password),
  },
  {
    id: 'lowercase',
    label: 'A lowercase letter (a–z)',
    problem: 'a lowercase letter',
    test: (password) => /[a-z]/.test(password),
  },
  {
    id: 'number',
    label: 'A number (0–9)',
    problem: 'a number',
    test: (password) => /[0-9]/.test(password),
  },
  {
    id: 'symbol',
    label: 'A symbol (anything other than a letter or number)',
    problem: 'a symbol',
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

/**
 * The server's rejection message, reproduced locally.
 *
 * `assertPasswordPolicy` throws
 * `Password must contain at least 12 characters, an uppercase letter, …` — this
 * returns the same sentence for the same input, so a user who trips the client
 * check sees exactly what the API would have said.
 */
export function passwordProblem(password: string): string | null {
  const problems = PASSWORD_REQUIREMENTS.filter((requirement) => !requirement.test(password)).map(
    (requirement) => requirement.problem,
  );
  if (problems.length === 0) return null;
  return `Password must contain ${problems.join(', ')}.`;
}

export interface PasswordEvaluation {
  /** Requirement id → met. */
  met: Record<PasswordRequirementId, boolean>;
  metCount: number;
  total: number;
  /** True only when EVERY requirement is met. */
  satisfiesPolicy: boolean;
}

export function evaluatePassword(password: string): PasswordEvaluation {
  const met = {} as Record<PasswordRequirementId, boolean>;
  let metCount = 0;
  for (const requirement of PASSWORD_REQUIREMENTS) {
    const ok = requirement.test(password);
    met[requirement.id] = ok;
    if (ok) metCount += 1;
  }
  return {
    met,
    metCount,
    total: PASSWORD_REQUIREMENTS.length,
    satisfiesPolicy: metCount === PASSWORD_REQUIREMENTS.length,
  };
}

export type PasswordStrengthTone = 'loss' | 'warn' | 'brand' | 'profit';

export interface PasswordStrength {
  /** 0–100, derived only from how many policy requirements are met. */
  percent: number;
  label: 'Empty' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  tone: PasswordStrengthTone;
}

/**
 * A deliberately simple, honest meter: it reports the share of the five policy
 * requirements that are satisfied and nothing else. It does not claim to
 * estimate entropy — a checker that scored "correcthorsebatterystaple" below
 * "P@ssw0rd1!" would be lying to the user.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) {
    return { percent: 0, label: 'Empty', tone: 'loss' };
  }
  const { metCount, total } = evaluatePassword(password);
  const percent = Math.round((metCount / total) * 100);

  if (metCount <= 2) return { percent, label: 'Weak', tone: 'loss' };
  if (metCount === 3) return { percent, label: 'Fair', tone: 'warn' };
  if (metCount === 4) return { percent, label: 'Good', tone: 'brand' };
  return { percent, label: 'Strong', tone: 'profit' };
}
