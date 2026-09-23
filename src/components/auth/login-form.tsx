'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import {
  allIssuesMapped,
  pickFieldIssues,
  postJson,
  type AuthResult,
} from '@/components/auth/api-client';
import { looksLikeEmail } from '@/components/auth/form-utils';
import { safeNextPath } from '@/components/auth/next-path';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { AuthLoginResponse } from '@/types/api';

/**
 * Sign-in form (client component).
 *
 * Talks to two API routes, in this order:
 *
 *   1. `POST /api/v1/auth/login`          { email, password }
 *   2. `POST /api/v1/auth/2fa/challenge`  { challengeId, token }   (only if 1 said so)
 *
 * Route 1 is two-step by design. Without 2FA it sets both httpOnly session
 * cookies and the response is `{ user, requires2FA: false }`. With 2FA it sets
 * NO cookie and answers `{ user, requires2FA: true, challengeId }` — the
 * challenge is the only thing standing between a correct password and a live
 * session, and it is single-use (consumed in Redis *before* the code is
 * checked, per `consume2faChallenge`). A wrong code therefore kills the
 * challenge, which is why this component stops offering the code box and sends
 * the user back to the password step after a 401 from route 2.
 *
 * Nothing auth-related is written to storage: the session is the API's
 * httpOnly cookie and this component only ever reads the API's own messages.
 */

/** Fields this form renders (used to map zod issues / aria wiring). */
const LOGIN_FIELDS = ['email', 'password'] as const;
type LoginField = (typeof LOGIN_FIELDS)[number];
type FieldErrors = Partial<Record<LoginField | 'code', string>>;

interface FormError {
  title: string;
  message: string;
  code: string;
}

/**
 * A pending second step. Mirrors `TWO_FACTOR_CHALLENGE_TTL_SECONDS = 300` and
 * `TOTP_PERIOD_SECONDS = 30` in
 * `src/server/modules/auth/twofactor.service.ts` — copied rather than imported
 * because that module pulls in Redis, Prisma and `speakeasy`, none of which may
 * reach the browser. The server remains the authority on both.
 */
interface TwoFactorPending {
  challengeId: string;
  /** Set once a 401 has been returned: the challenge is spent and cannot retry. */
  consumed: boolean;
}

const CHALLENGE_TTL_MINUTES = 5;
const TOTP_PERIOD_SECONDS = 30;

function errorTitle(statusCode: number): string {
  if (statusCode === 429) return 'Too many attempts';
  if (statusCode === 422) return 'Check your details';
  if (statusCode === 400) return 'Request rejected';
  return 'Sign-in failed';
}

export interface LoginFormProps {
  /**
   * Where to go on success. Already validated by `src/app/(auth)/login/page.tsx`
   * with {@link safeNextPath}; re-validated here before any navigation.
   */
  nextPath: string;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState<TwoFactorPending | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<FormError | null>(null);
  const [busy, setBusy] = React.useState(false);

  const codeRef = React.useRef<HTMLInputElement>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus the code box the moment the second step appears — the user is
  // mid-authentication and should not have to reach for the mouse.
  React.useEffect(() => {
    if (pending) codeRef.current?.focus();
  }, [pending]);

  const finishLogin = React.useCallback(() => {
    const destination = safeNextPath(nextPath);
    router.push(destination);
    // The session cookie is now set, so server components must re-render: the
    // dashboard layout would otherwise be served from the previous render.
    router.refresh();
  }, [nextPath, router]);

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
      finishLogin();
      return;
    }

    if (result.statusCode === 422) {
      const mapped = pickFieldIssues(result.issues, LOGIN_FIELDS);
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
      finishLogin();
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

  const fieldErrorProps = (field: LoginField | 'code') => {
    const error = fieldErrors[field];
    return {
      invalid: error ? true : undefined,
      describedBy: error ? `login-${field}-error` : undefined,
    } as const;
  };

  if (pending) {
    const codeField = fieldErrorProps('code');
    return (
      <AuthCard
        title="Two-factor verification"
        description={
          <>
            Enter the 6-digit code from your authenticator app for{' '}
            <span className="text-base-100">{email.trim() || 'your account'}</span>.
          </>
        }
        footer={
          <p className="text-xs leading-relaxed">
            Codes change every {TOTP_PERIOD_SECONDS} seconds, so a code from the previous screen may
            already be stale. Lost your authenticator? Email support@autopips.pro — a factor reset is
            recorded in the audit trail.
          </p>
        }
      >
        <form noValidate onSubmit={submitTwoFactor} className="flex flex-col gap-5">
          <div aria-live="polite">
            {formError ? (
              <Alert variant="danger">
                <AlertTitle>{formError.title}</AlertTitle>
                <AlertDescription>{formError.message}</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info" icon={ShieldCheck} className="py-3">
                <AlertDescription className="text-xs">
                  This step expires {CHALLENGE_TTL_MINUTES} minutes after your password was
                  accepted. If it lapses — or if a code is not accepted — sign-in must be started
                  again.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="login-code">Authentication code</Label>
            <Input
              id="login-code"
              ref={codeRef}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="123456"
              value={code}
              aria-invalid={codeField.invalid}
              aria-describedby={codeField.describedBy}
              onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
              disabled={pending.consumed}
              className="tabular w-40 tracking-[0.3em]"
            />
            {fieldErrors.code ? (
              <p id="login-code-error" className="text-xs text-loss-400">
                {fieldErrors.code}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {pending.consumed ? (
              <Button variant="primary" type="button" onClick={restart}>
                <ArrowLeft aria-hidden />
                Start sign-in again
              </Button>
            ) : (
              <>
                <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
                  {busy ? <Spinner size="sm" label="Verifying" /> : <KeyRound aria-hidden />}
                  {busy ? 'Verifying…' : 'Verify and sign in'}
                </Button>
                <Button variant="ghost" type="button" onClick={restart} disabled={busy}>
                  Back
                </Button>
              </>
            )}
          </div>
        </form>
      </AuthCard>
    );
  }

  const emailField = fieldErrorProps('email');
  const passwordField = fieldErrorProps('password');

  return (
    <AuthCard
      title="Sign in"
      description="Use the email address and password on your account."
      footer={
        <div className="flex flex-col gap-2 text-xs leading-relaxed">
          <p>
            No account yet?{' '}
            <Link
              href="/register"
              className="rounded-sm text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
            >
              Open an account
            </Link>
            .
          </p>
          <p>
            Forgotten your password? There is no self-service reset — email support@autopips.pro
            from the address on the account.
          </p>
        </div>
      }
    >
      <form noValidate onSubmit={submitCredentials} className="flex flex-col gap-5">
        <div aria-live="polite">
          {formError ? (
            <Alert variant="danger">
              <AlertTitle>{formError.title}</AlertTitle>
              <AlertDescription>{formError.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="login-email">Email address</Label>
          <Input
            id="login-email"
            ref={emailRef}
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            aria-invalid={emailField.invalid}
            aria-describedby={emailField.describedBy}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
          {fieldErrors.email ? (
            <p id="login-email-error" className="text-xs text-loss-400">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            aria-invalid={passwordField.invalid}
            aria-describedby={passwordField.describedBy}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          {fieldErrors.password ? (
            <p id="login-password-error" className="text-xs text-loss-400">
              {fieldErrors.password}
            </p>
          ) : null}
        </div>

        <Button type="submit" variant="primary" size="lg" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner size="sm" label="Signing in" /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="text-xs leading-relaxed text-muted">
          Your session is held in httpOnly cookies set by the server. Nothing about it is written to
          localStorage, and this page never handles a token.
        </p>
      </form>
    </AuthCard>
  );
}

export default LoginForm;
