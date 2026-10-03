'use client';

import * as React from 'react';

import {
  allIssuesMapped,
  pickFieldIssues,
  postJson,
  type AuthResult,
} from '@/components/auth/api-client';
import { looksLikeEmail } from '@/components/auth/form-utils';
import type { AuthLoginResponse, SessionUser } from '@/types/api';

/**
 * The password sign-in FLOW, shared by the client and the admin console.
 *
 * Two screens, two visual languages, one implementation of authentication. The
 * screens own their layout and their copy; this hook owns the sequence, the
 * validation, the error mapping and the two-step 2FA handshake — the parts where
 * a second, drifted copy would be a security defect rather than a styling
 * annoyance.
 *
 * It talks to two API routes, in this order:
 *
 *   1. `POST /api/v1/auth/login`          { email, password }
 *   2. `POST /api/v1/auth/2fa/challenge`  { challengeId, token }   (only if 1 said so)
 *
 * Route 1 is two-step by design. Without 2FA it sets both httpOnly session
 * cookies and the response is `{ user, requires2FA: false }`. With 2FA it sets
 * NO cookie and answers `{ user, requires2FA: true, challengeId }` — the
 * challenge is the only thing standing between a correct password and a live
 * session, and it is single-use (consumed in Redis *before* the code is
 * checked). A wrong code therefore kills the challenge, which is why the code
 * step is closed rather than left inviting a retry that cannot succeed.
 *
 * Nothing auth-related is written to storage: the session is the API's httpOnly
 * cookie. No token ever reaches this module.
 */

/** Fields the password step renders. */
export const PASSWORD_FIELDS = ['email', 'password'] as const;
export type PasswordField = (typeof PASSWORD_FIELDS)[number];
/** Everything either step can report an error against. */
export type LoginField = PasswordField | 'code';
export type FieldErrors = Partial<Record<LoginField, string>>;

export interface FormError {
  title: string;
  message: string;
  code: string;
}

/** A pending second step. Mirrors the server's challenge lifetime. */
export interface TwoFactorPending {
  challengeId: string;
  /** Set once a 401 has been returned: the challenge is spent and cannot retry. */
  consumed: boolean;
}

/**
 * Mirrors `TWO_FACTOR_CHALLENGE_TTL_SECONDS = 300` and `TOTP_PERIOD_SECONDS = 30`
 * in `src/server/modules/auth/twofactor.service.ts` — copied rather than
 * imported because that module pulls in Redis, Prisma and `speakeasy`, none of
 * which may reach the browser. The server remains the authority on both.
 */
export const CHALLENGE_TTL_MINUTES = 5;
export const TOTP_PERIOD_SECONDS = 30;

export function errorTitle(statusCode: number): string {
  if (statusCode === 429) return 'Too many attempts';
  if (statusCode === 422) return 'Check your details';
  if (statusCode === 400) return 'Request rejected';
  return 'Sign-in failed';
}

export interface UsePasswordLoginOptions {
  /**
   * Called once a session EXISTS — never navigates on its own, because the two
   * screens disagree about what happens next: the client goes to its
   * destination, the console first checks the account is staff and may end the
   * session again rather than let a client into the back office.
   */
  onAuthenticated: (user: SessionUser) => void | Promise<void>;
}

export interface PasswordLoginController {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  pending: TwoFactorPending | null;
  fieldErrors: FieldErrors;
  formError: FormError | null;
  /** Exposed so a caller can report a failure of its own (role refusal). */
  setFormError: (error: FormError | null) => void;
  busy: boolean;
  emailRef: React.RefObject<HTMLInputElement>;
  codeRef: React.RefObject<HTMLInputElement>;
  submitCredentials: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  submitTwoFactor: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  restart: () => void;
  /** `{ invalid, describedBy }` for a field's aria wiring. */
  fieldErrorProps: (field: LoginField) => { invalid?: true; describedBy?: string };
}

export function usePasswordLogin({
  onAuthenticated,
}: UsePasswordLoginOptions): PasswordLoginController {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState<TwoFactorPending | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<FormError | null>(null);
  const [busy, setBusy] = React.useState(false);

  const codeRef = React.useRef<HTMLInputElement>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);

  // The success callback is read through a ref so it cannot re-create the
  // submit handlers mid-request (a re-render during the fetch would otherwise
  // swap the handler the form has already bound).
  const successRef = React.useRef(onAuthenticated);
  React.useEffect(() => {
    successRef.current = onAuthenticated;
  }, [onAuthenticated]);

  // Auto-focus the code box the moment the second step appears — the user is
  // mid-authentication and should not have to reach for the mouse.
  React.useEffect(() => {
    if (pending) codeRef.current?.focus();
  }, [pending]);

  const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const trimmedEmail = email.trim();
    const errors: FieldErrors = {};
    if (!trimmedEmail) {
      errors.email = 'Enter the email address on your account.';
    } else if (!looksLikeEmail(trimmedEmail)) {
      errors.email = 'That does not look like an email address.';
    }
    if (!password) errors.password = 'Enter your password.';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setBusy(true);
    const result: AuthResult<AuthLoginResponse> = await postJson('/api/v1/auth/login', {
      email: trimmedEmail,
      password,
    });
    setBusy(false);

    if (result.kind === 'network') {
      setFormError({ title: 'Could not reach the server', message: result.message, code: 'NETWORK' });
      return;
    }

    if (result.kind === 'ok') {
      const { requires2FA, challengeId } = result.data;
      if (requires2FA && challengeId) {
        setPassword('');
        setCode('');
        setFieldErrors({});
        setPending({ challengeId, consumed: false });
        return;
      }
      await successRef.current(result.data.user);
      return;
    }

    if (result.statusCode === 422) {
      const mapped = pickFieldIssues(result.issues, PASSWORD_FIELDS);
      setFieldErrors(mapped);
      setFormError(
        result.issues.length > 0 && allIssuesMapped(result.issues, mapped)
          ? {
              title: errorTitle(result.statusCode),
              message: 'Please correct the highlighted fields and try again.',
              code: result.code,
            }
          : { title: errorTitle(result.statusCode), message: result.message, code: result.code },
      );
      return;
    }

    // 400 / 401 / 429 and anything else: the API's own message, verbatim. Its
    // 401 copy is deliberately identical for an unknown address and a wrong
    // password, and repeating it here preserves that.
    setFormError({ title: errorTitle(result.statusCode), message: result.message, code: result.code });
  };

  const submitTwoFactor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !pending || pending.consumed) return;

    const token = code.trim();
    if (!/^\d{6}$/.test(token)) {
      setFieldErrors({ code: 'Enter the 6-digit code from your authenticator app.' });
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setBusy(true);
    const result: AuthResult<AuthLoginResponse> = await postJson('/api/v1/auth/2fa/challenge', {
      challengeId: pending.challengeId,
      token,
    });
    setBusy(false);

    if (result.kind === 'network') {
      setFormError({ title: 'Could not reach the server', message: result.message, code: 'NETWORK' });
      return;
    }

    if (result.kind === 'ok') {
      await successRef.current(result.data.user);
      return;
    }

    // A 401 here means the challenge was consumed before the code was checked
    // (expired, replayed, or simply wrong). No further attempt can succeed
    // against this challengeId, so the code box is closed rather than left
    // inviting a retry that cannot work.
    if (result.statusCode === 401) {
      setPending({ ...pending, consumed: true });
    }
    setFormError({ title: errorTitle(result.statusCode), message: result.message, code: result.code });
  };

  const restart = () => {
    setPending(null);
    setCode('');
    setFieldErrors({});
    setFormError(null);
    setPassword('');
    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const fieldErrorProps = (field: LoginField) => {
    const error = fieldErrors[field];
    return {
      invalid: error ? (true as const) : undefined,
      describedBy: error ? `login-${field}-error` : undefined,
    };
  };

  return {
    email,
    setEmail,
    password,
    setPassword,
    code,
    setCode,
    pending,
    fieldErrors,
    formError,
    setFormError,
    busy,
    emailRef,
    codeRef,
    submitCredentials,
    submitTwoFactor,
    restart,
    fieldErrorProps,
  };
}
