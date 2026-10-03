'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Bot,
  Eye,
  EyeOff,
  KeyRound,
  LineChart,
  Lock,
  ShieldAlert,
  ShieldCheck,
  User,
} from 'lucide-react';

import { BrandMark } from '@/components/shared/brand-mark';
import { postJson } from '@/components/auth/api-client';
import {
  CHALLENGE_TTL_MINUTES,
  usePasswordLogin,
} from '@/components/auth/use-password-login';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { SessionUser } from '@/types/api';

/**
 * Super-admin console sign-in (client component).
 *
 * Presentation is the console's own — light surface, restricted-area framing —
 * but the FLOW is `use-password-login.ts`, shared with the client sign-in: one
 * implementation of the password → 2FA sequence, so the two screens cannot
 * disagree about how a session is obtained.
 *
 * Two things this screen does that the client one must not:
 *
 *   1. ROLE GATE. A correct password for a CLIENT account produces a live
 *      session — and then this component ENDS it (POST /api/v1/auth/logout)
 *      instead of leaving a client holding a session that the back-office APIs
 *      will refuse anyway. Half-access is worse than no access: the client would
 *      read console-styled pages full of 403s.
 *   2. NO "create an account" path. The console is not self-service.
 *
 * Session storage is the server's httpOnly cookie. The console spec offered
 * "secure HttpOnly admin session cookie or encrypted local storage key" — only
 * the first is acceptable here, and it is what the API already does: a token in
 * localStorage is readable by any script on the page, and this console's pages
 * load the audit log and client documents.
 */

const STAFF_ROLES: readonly SessionUser['role'][] = ['ADMIN', 'TRADING_MANAGER'];

export interface AdminLoginFormProps {
  /**
   * Console path to open after a successful sign-in. Already validated by the
   * page with `safeAdminNextPath` (console paths only).
   */
  nextPath?: string;
}

export function AdminLoginForm({ nextPath = '/admin' }: AdminLoginFormProps) {
  const router = useRouter();
  const [showPassword, setShowPassword] = React.useState(false);

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
    setFormError,
    busy,
    emailRef,
    codeRef,
    submitCredentials,
    submitTwoFactor,
    restart,
    fieldErrorProps,
  } = usePasswordLogin({
    onAuthenticated: async (user) => {
      if (!STAFF_ROLES.includes(user.role)) {
        // End the session we just created: this account is not staff.
        await postJson('/api/v1/auth/logout', {});
        setFormError({
          title: 'Console access required',
          message:
            'That account is not a console account. It has been signed out — use the client sign-in for your trading dashboard.',
          code: 'FORBIDDEN',
        });
        return;
      }
      router.push(nextPath);
      // The session cookie is set, so server components must re-render.
      router.refresh();
    },
  });

  if (pending) {
    const codeField = fieldErrorProps('code');
    return (
      <div className="rounded-2xl border border-line bg-base-850 p-6 shadow-card sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-base-800">
            <ShieldCheck aria-hidden className="size-5 text-brand-400" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-base-100">
            Console verification
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            Enter the 6-digit code from the authenticator app enrolled on{' '}
            <span className="text-base-100">{email.trim() || 'this account'}</span>.
          </p>
        </div>

        <form noValidate onSubmit={submitTwoFactor} className="mt-6 flex flex-col gap-5">
          <div aria-live="polite">
            {formError ? (
              <Alert variant="danger">
                <AlertTitle>{formError.title}</AlertTitle>
                <AlertDescription>{formError.message}</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info" icon={ShieldCheck} className="py-3">
                <AlertDescription className="text-xs">
                  This step expires {CHALLENGE_TTL_MINUTES} minutes after the password was accepted.
                  If it lapses, console sign-in must be started again.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-code" className="uppercase tracking-wide">
              Authentication code
            </Label>
            <Input
              id="admin-code"
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
              className="tabular w-40 text-center tracking-[0.3em]"
            />
            {fieldErrors.code ? (
              <p id="login-code-error" className="text-xs text-loss-400">
                {fieldErrors.code}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {pending.consumed ? (
              <Button variant="primary" type="button" onClick={restart} className="w-full">
                <ArrowRight aria-hidden className="rotate-180" />
                Start sign-in again
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy}
                  aria-busy={busy}
                  className="flex-1"
                >
                  {busy ? <Spinner size="sm" label="Verifying" /> : <KeyRound aria-hidden />}
                  {busy ? 'Verifying…' : 'Verify and open console'}
                </Button>
                <Button variant="outline" type="button" onClick={restart} disabled={busy}>
                  Back
                </Button>
              </>
            )}
          </div>
        </form>
      </div>
    );
  }

  const emailField = fieldErrorProps('email');
  const passwordField = fieldErrorProps('password');

  return (
    <div className="rounded-2xl border border-line bg-base-850 p-6 shadow-card sm:p-8">
      {/* Restricted-area framing: this is not the client sign-in. */}
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-base-700/70 px-3 py-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-base-100">
          <ShieldAlert aria-hidden className="size-3.5 text-warn-400" />
          Restricted area · Admin authentication
        </span>
      </div>

      <div className="mt-6 flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-base-800 shadow-card">
          <BrandMark size="lg" showWordmark={false} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold uppercase tracking-[0.16em] text-base-100">
            Autopipsz Super Admin
          </h1>
          <p className="text-[0.65rem] uppercase tracking-[0.16em] text-muted">
            Platform management &amp; bot operations
          </p>
        </div>
      </div>

      <form noValidate onSubmit={submitCredentials} className="mt-7 flex flex-col gap-5">
        <div aria-live="polite">
          {formError ? (
            <Alert variant="danger">
              <AlertTitle>{formError.title}</AlertTitle>
              <AlertDescription>
                {formError.message}
                {formError.code === 'FORBIDDEN' ? (
                  <>
                    {' '}
                    <Link
                      href="/login"
                      className="rounded-sm font-medium text-brand-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                      Client sign-in
                    </Link>
                    .
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {/*
            The spec asked for an "Admin identifier / phone". The platform
            authenticates by EMAIL only — there is no phone lookup and no
            "superadmin" alias — so inventing one would create a sign-in path
            that does not exist. The label says what actually works.
          */}
          <Label htmlFor="admin-email" className="uppercase tracking-wide">
            Admin email
          </Label>
          <div className="relative">
            <User
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              id="admin-email"
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
              placeholder="you@autopips.pro"
              className="pl-9"
            />
          </div>
          {fieldErrors.email ? (
            <p id="login-email-error" className="text-xs text-loss-400">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="admin-password" className="uppercase tracking-wide">
            Password
          </Label>
          <div className="relative">
            <Lock
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              id="admin-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              aria-invalid={passwordField.invalid}
              aria-describedby={passwordField.describedBy}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              className="pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              disabled={busy}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50"
            >
              {showPassword ? (
                <EyeOff aria-hidden className="size-4" />
              ) : (
                <Eye aria-hidden className="size-4" />
              )}
            </button>
          </div>
          {fieldErrors.password ? (
            <p id="login-password-error" className="text-xs text-loss-400">
              {fieldErrors.password}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={busy}
          aria-busy={busy}
          className="w-full"
        >
          {busy ? <Spinner size="sm" label="Signing in" /> : <ArrowRight aria-hidden />}
          {busy ? 'Signing in…' : 'Sign in to console'}
        </Button>

        <p className="text-xs leading-relaxed text-muted">
          Sessions are held in httpOnly cookies set by the server. Nothing about them is written to
          localStorage, and this page never handles a token.
        </p>
      </form>

      {/* Console quick links — real destinations, not decoration. */}
      <div className="mt-6 flex items-center justify-center gap-4 border-t border-line pt-5">
        <Link
          href="/admin/bot-control"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <Bot aria-hidden className="size-3.5 text-brand-400" />
          Bot Control
        </Link>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <Link
          href="/admin/brokers"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-base-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <LineChart aria-hidden className="size-3.5 text-brand-400" />
          Deriv Monitor
        </Link>
      </div>
    </div>
  );
}

export default AdminLoginForm;
