'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Circle, CircleAlert, CircleCheck, UserPlus } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { pickFieldIssues, postJson, type AuthResult } from '@/components/auth/api-client';
import { COUNTRIES } from '@/components/auth/countries';
import { FIELD_LIMITS, looksLikeEmail } from '@/components/auth/form-utils';
import {
  PASSWORD_POLICY,
  PASSWORD_REQUIREMENTS,
  evaluatePassword,
  passwordProblem,
  passwordStrength,
  type PasswordStrengthTone,
} from '@/components/auth/password-policy';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, inputClassName } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { SessionUser } from '@/types/api';

/**
 * Registration form (client component).
 *
 * `POST /api/v1/auth/register` takes exactly
 * `{ email, password, fullName, country, phone? }` and answers **201** with the
 * created `SessionUser`. It deliberately does NOT sign the account in — no
 * cookie is minted by that route, and there is no session to hijack between
 * "created" and "first authenticated". This form therefore ends on a success
 * panel that hands the user to `/login`, rather than pretending a session
 * exists.
 *
 * The password checklist is fed by `components/auth/password-policy.ts`, a
 * client-safe mirror of the server's `PASSWORD_POLICY`. The server is the
 * authority: a policy failure that reaches the API comes back as a 400 whose
 * message is the same sentence this form would have produced locally, and is
 * placed on the password field.
 */

/** Fields the API accepts (mapped from zod issues and wired to aria attributes). */
const REGISTER_FIELDS = ['fullName', 'email', 'country', 'phone', 'password'] as const;
type RegisterField = (typeof REGISTER_FIELDS)[number];
type FieldErrors = Partial<Record<RegisterField | 'confirmPassword', string>>;

interface FormValues {
  fullName: string;
  email: string;
  country: string;
  phone: string;
  password: string;
  confirmPassword: string;
}

const EMPTY_FORM: FormValues = {
  fullName: '',
  email: '',
  country: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

const STRENGTH_TEXT: Record<PasswordStrengthTone, string> = {
  loss: 'text-loss-400',
  warn: 'text-warn-400',
  brand: 'text-brand-300',
  profit: 'text-profit-400',
};

interface FormError {
  title: string;
  message: string;
  /** Rendered as a sign-in link under the message (409 = the address is taken). */
  signInHint?: boolean;
}

function errorTitle(statusCode: number): string {
  if (statusCode === 409) return 'That email is already registered';
  if (statusCode === 422) return 'Check your details';
  if (statusCode === 429) return 'Too many sign-up attempts';
  return 'Account not created';
}

/**
 * Zod reports the API's own field paths; this narrows them to the fields the
 * form actually renders. Anything left over is surfaced as a form-level message
 * instead of being dropped.
 */
function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};

  const fullName = values.fullName.trim();
  if (!fullName) errors.fullName = 'Enter your full name as it appears on your ID.';
  else if (fullName.length < FIELD_LIMITS.fullName.min) errors.fullName = 'That name is too short.';
  else if (fullName.length > FIELD_LIMITS.fullName.max) errors.fullName = 'That name is too long.';

  const email = values.email.trim();
  if (!email) errors.email = 'Enter an email address.';
  else if (email.length > FIELD_LIMITS.email.max) errors.email = 'That email address is too long.';
  else if (!looksLikeEmail(email)) errors.email = 'That does not look like an email address.';

  if (!values.country) errors.country = 'Select the country you are resident in.';

  const phone = values.phone.trim();
  if (phone.length > 0) {
    if (phone.length < FIELD_LIMITS.phone.min || phone.length > FIELD_LIMITS.phone.max) {
      errors.phone = `A phone number must be between ${FIELD_LIMITS.phone.min} and ${FIELD_LIMITS.phone.max} characters.`;
    }
  }

  const problem = passwordProblem(values.password);
  if (problem) errors.password = problem;
  else if (values.password.length > PASSWORD_POLICY.maxLength) {
    errors.password = `Password must be at most ${PASSWORD_POLICY.maxLength} characters.`;
  }

  if (values.confirmPassword !== values.password) {
    errors.confirmPassword = 'The two passwords do not match.';
  }

  return errors;
}

export interface RegisterFormProps {
  className?: string;
}

export function RegisterForm({ className }: RegisterFormProps) {
  const [values, setValues] = React.useState<FormValues>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<FormError | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState<{ email: string } | null>(null);

  const strength = passwordStrength(values.password);
  const evaluation = evaluatePassword(values.password);

  const update = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    // Clear a field's error as soon as the user edits it; the re-check happens
    // on submit, so nothing is re-flagged mid-typing.
    setFieldErrors((previous) => {
      if (!(field in previous)) return previous;
      const next = { ...previous };
      delete next[field as keyof FieldErrors];
      return next;
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError(null);
      return;
    }

    const trimmedPhone = values.phone.trim();
    const body: {
      email: string;
      password: string;
      fullName: string;
      country: string;
      phone?: string;
    } = {
      email: values.email.trim().toLowerCase(),
      password: values.password,
      fullName: values.fullName.trim(),
      country: values.country,
    };
    // The API's schema is `.optional()` with `min(6)`, so an empty string must
    // be omitted rather than sent.
    if (trimmedPhone) body.phone = trimmedPhone;

    setFieldErrors({});
    setFormError(null);
    setBusy(true);
    const result: AuthResult<SessionUser> = await postJson('/api/v1/auth/register', body);
    setBusy(false);

    if (result.kind === 'network') {
      setFormError({ title: 'Could not reach the server', message: result.message });
      return;
    }

    if (result.kind === 'ok') {
      const email = typeof result.data?.email === 'string' ? result.data.email : body.email;
      setValues(EMPTY_FORM);
      setFieldErrors({});
      setCreated({ email });
      return;
    }

    if (result.statusCode === 409) {
      setFormError({ title: errorTitle(409), message: result.message, signInHint: true });
      return;
    }

    if (result.statusCode === 422) {
      const mapped = pickFieldIssues(result.issues, REGISTER_FIELDS);
      setFieldErrors(mapped);
      const unmapped = result.issues.filter((issue) => mapped[issue.path as RegisterField] === undefined);
      setFormError({
        title: errorTitle(422),
        message:
          result.issues.length === 0
            ? result.message
            : unmapped.length > 0
              ? unmapped.map((issue) => issue.message).join(' ')
              : 'Please correct the highlighted fields and try again.',
      });
      return;
    }

    if (result.statusCode === 400) {
      // The route translates a password-policy violation into a 400 carrying the
      // policy sentence. Put it on the password field where it belongs.
      const isPolicyFailure = result.message.startsWith('Password must contain');
      if (isPolicyFailure) {
        setFieldErrors({ password: result.message });
        setFormError({ title: 'Choose a different password', message: result.message });
        return;
      }
      setFormError({ title: errorTitle(400), message: result.message });
      return;
    }

    setFormError({ title: errorTitle(result.statusCode), message: result.message });
  };

  const errorProps = (field: RegisterField | 'confirmPassword') => {
    const error = fieldErrors[field];
    return {
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? `register-${field}-error` : undefined,
    };
  };

  if (created) {
    return (
      <AuthCard
        title="Account created"
        description="Your account exists. Registration does not start a session, so sign in next."
        className={className}
        footer={
          <p className="text-xs leading-relaxed">
            Created with <span className="text-base-100">{created.email}</span>. Deposits, capital
            allocation and withdrawals all require an approved identity review.
          </p>
        }
      >
        <div className="flex flex-col gap-5">
          <Alert variant="success">
            <AlertTitle>Nothing else is required to sign in</AlertTitle>
            <AlertDescription>
              The account was created without a session on purpose: the API does not log you in on
              registration. Use the email address above and the password you just chose.
            </AlertDescription>
          </Alert>

          <Button type="button" variant="primary" size="lg" asChild>
            <Link href="/login">
              Continue to sign in
              <ArrowRight aria-hidden />
            </Link>
          </Button>

          <p className="text-xs leading-relaxed text-muted">
            After signing in you can complete identity verification, request a deposit and allocate
            capital to a strategy. Documents you upload are stored privately and reviewed by a human.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Open an account"
      description="One account per email address. You must be at least 18 years old."
      className={className}
      footer={
        <p className="text-xs leading-relaxed">
          Already have an account?{' '}
          <Link
            href="/login"
            className="rounded-sm text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          >
            Sign in
          </Link>
          . Registration does not sign you in automatically.
        </p>
      }
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <div aria-live="polite">
          {formError ? (
            <Alert variant={formError.signInHint ? 'warn' : 'danger'}>
              <AlertTitle>{formError.title}</AlertTitle>
              <AlertDescription>
                {formError.message}
                {formError.signInHint ? (
                  <>
                    {' '}
                    <Link
                      href="/login"
                      className="text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                      Sign in instead
                    </Link>
                    , or register with a different address.
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <Field id="register-full-name" label="Full name" error={fieldErrors.fullName} required>
          <Input
            id="register-full-name"
            name="fullName"
            type="text"
            autoComplete="name"
            required
            maxLength={FIELD_LIMITS.fullName.max}
            value={values.fullName}
            onChange={(event) => update('fullName', event.target.value)}
            disabled={busy}
            {...errorProps('fullName')}
          />
        </Field>

        <Field
          id="register-email"
          label="Email address"
          error={fieldErrors.email}
          hint="Used to sign in and for account notices. It cannot be changed here."
          required
        >
          <Input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={FIELD_LIMITS.email.max}
            value={values.email}
            onChange={(event) => update('email', event.target.value)}
            disabled={busy}
            {...errorProps('email')}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="register-country" label="Country of residence" error={fieldErrors.country} required>
            <select
              id="register-country"
              name="country"
              required
              value={values.country}
              onChange={(event) => update('country', event.target.value)}
              disabled={busy}
              className={cn(inputClassName, 'pr-8')}
              {...errorProps('country')}
            >
              <option value="">Select your country</option>
              {COUNTRIES.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="register-phone"
            label="Phone (optional)"
            error={fieldErrors.phone}
            hint="Only used to reach you about this account."
          >
            <Input
              id="register-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={FIELD_LIMITS.phone.max}
              value={values.phone}
              onChange={(event) => update('phone', event.target.value)}
              disabled={busy}
              {...errorProps('phone')}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="register-password">
            Password
            <span className="ml-1 text-muted" aria-hidden>
              *
            </span>
          </Label>
          <Input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_POLICY.maxLength}
            value={values.password}
            onChange={(event) => update('password', event.target.value)}
            disabled={busy}
            {...errorProps('password')}
          />
          {fieldErrors.password ? (
            <p id="register-password-error" className="flex items-start gap-1 text-xs text-loss-400">
              <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
              {fieldErrors.password}
            </p>
          ) : null}

          <div className="mt-1 flex flex-col gap-3 rounded-lg border border-line bg-base-900/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted">Password strength</span>
              <span className={cn('text-xs font-medium', STRENGTH_TEXT[strength.tone])}>
                {strength.label} · {evaluation.metCount} of {evaluation.total} requirements
              </span>
            </div>
            <Progress value={strength.percent} tone={strength.tone} aria-hidden />
            <ul className="flex flex-col gap-1.5">
              {PASSWORD_REQUIREMENTS.map((requirement) => {
                const met = evaluation.met[requirement.id];
                return (
                  <li key={requirement.id} className="flex items-center gap-2">
                    {met ? (
                      <CircleCheck aria-hidden className="size-3.5 shrink-0 text-profit-400" />
                    ) : (
                      <Circle aria-hidden className="size-3.5 shrink-0 text-muted/60" />
                    )}
                    <span className={cn('text-xs', met ? 'text-base-100' : 'text-muted')}>
                      {requirement.label}
                    </span>
                    <span className="sr-only">
                      {met ? '— requirement met' : '— requirement not met'}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs leading-relaxed text-muted">
              The API enforces the same policy ({PASSWORD_POLICY.minLength} characters minimum with
              upper case, lower case, a number and a symbol) — this checklist is the same rule, shown
              early.
            </p>
          </div>
        </div>

        <Field
          id="register-confirm-password"
          label="Confirm password"
          error={fieldErrors.confirmPassword}
          required
        >
          <Input
            id="register-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_POLICY.maxLength}
            value={values.confirmPassword}
            onChange={(event) => update('confirmPassword', event.target.value)}
            disabled={busy}
            {...errorProps('confirmPassword')}
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner size="sm" label="Creating account" /> : <UserPlus aria-hidden />}
          {busy ? 'Creating account…' : 'Create account'}
        </Button>

        <p className="text-xs leading-relaxed text-muted">
          Your password is sent over the same-origin API and stored as an Argon2id hash. It is never
          written to localStorage or any part of the page.
        </p>
      </form>
    </AuthCard>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

/** Label + control + error/hint, wired to the same ids the aria attributes use. */
function Field({ id, label, error, hint, required = false, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-1 text-muted" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1 text-xs text-loss-400">
          <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default RegisterForm;
