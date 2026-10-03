import { z } from 'zod';

/**
 * Contact-form contract, shared by the client form and the API route so the
 * two can never disagree about what is acceptable.
 *
 * Pure zod, no imports beyond the schema library — safe to pull into both the
 * browser bundle and a server route handler.
 */

export const CONTACT_SUBJECTS = [
  'GENERAL',
  'ACCOUNT',
  'PAYMENTS',
  'KYC',
  'SECURITY',
  'COMPLIANCE',
  'OTHER',
] as const;

export type ContactSubject = (typeof CONTACT_SUBJECTS)[number];

/** Human labels for the subject picker. */
export const CONTACT_SUBJECT_LABEL: Record<ContactSubject, string> = {
  GENERAL: 'General question',
  ACCOUNT: 'Account and sign-in',
  PAYMENTS: 'Deposits and withdrawals',
  KYC: 'Identity verification',
  SECURITY: 'Security report',
  COMPLIANCE: 'Compliance enquiry',
  OTHER: 'Something else',
};

export const CONTACT_MESSAGE_MAX_LENGTH = 4000;
export const CONTACT_NAME_MAX_LENGTH = 120;
export const CONTACT_SUBJECT_MAX_LENGTH = 160;

export const contactMessageSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Please give us a name to reply to.')
    .max(CONTACT_NAME_MAX_LENGTH, `Keep the name under ${CONTACT_NAME_MAX_LENGTH} characters.`),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'An email address is required so we can reply.')
    .max(254, 'That email address is too long.')
    .email('Enter a valid email address.'),
  subject: z.enum(CONTACT_SUBJECTS, {
    errorMap: () => ({ message: 'Choose a subject.' }),
  }),
  /** Optional one-line subject detail; the enum above already categorises it. */
  subjectLine: z
    .string()
    .trim()
    .max(CONTACT_SUBJECT_MAX_LENGTH, `Keep this under ${CONTACT_SUBJECT_MAX_LENGTH} characters.`)
    .optional(),
  message: z
    .string()
    .trim()
    .min(20, 'Please include at least 20 characters of detail so we can help.')
    .max(CONTACT_MESSAGE_MAX_LENGTH, `Keep the message under ${CONTACT_MESSAGE_MAX_LENGTH} characters.`),
});

export type ContactMessageInput = z.infer<typeof contactMessageSchema>;

/** Field-scoped validation errors, keyed by form field name. */
export type ContactFieldErrors = Partial<Record<keyof ContactMessageInput, string>>;

/**
 * Runs the schema and returns `{ data }` on success or `{ errors }` keyed by
 * field. Used by the client form so it never has to read zod internals.
 */
export function validateContactMessage(
  input: unknown,
): { data: ContactMessageInput; errors: null } | { data: null; errors: ContactFieldErrors } {
  const parsed = contactMessageSchema.safeParse(input);
  if (parsed.success) return { data: parsed.data, errors: null };

  const errors: ContactFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string') continue;
    const key = field as keyof ContactMessageInput;
    if (!errors[key]) errors[key] = issue.message;
  }
  return { data: null, errors };
}
