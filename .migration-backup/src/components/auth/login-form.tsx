'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { safeNextPath } from '@/components/auth/next-path';
import {
  CHALLENGE_TTL_MINUTES,
  TOTP_PERIOD_SECONDS,
  usePasswordLogin,
} from '@/components/auth/use-password-login';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/**
 * Client sign-in form (dark trading surface).
 *
 * Presentation only: the sequence, validation, error mapping and 2FA handshake
 * live in `use-password-login.ts`, shared with the admin console's sign-in.
 */

export interface LoginFormProps {
  /**
   * Where to go on success. Already validated by `src/app/(auth)/login/page.tsx`
   * with {@link safeNextPath}; re-validated here before any navigation.
   */
  nextPath: string;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();

  const {
    email,
    setEmail,
    password,
    setPassword,
    code,
    setCode,
    pending,
    fieldErrors,
    formError,
    busy,
    emailRef,
    codeRef,
    submitCredentials,
    submitTwoFactor,
    restart,
    fieldErrorProps,
  } = usePasswordLogin({
    onAuthenticated: () => {
      router.push(safeNextPath(nextPath));
      // The session cookie is now set, so server components must re-render: the
      // dashboard layout would otherwise be served from the previous render.
      router.refresh();
    },
  });

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
