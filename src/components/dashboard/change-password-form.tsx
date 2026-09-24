'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Change your own password (client component).
 *
 * Used by BOTH the client dashboard (Profile & security) and the admin console,
 * because the need is identical: the bootstrap administrator starts with a
 * password that came out of an environment variable, and a client may want to
 * rotate theirs at any time.
 *
 * The policy is passed in from the server rather than duplicated here, so this
 * form can never advertise a rule the API does not enforce
 * (src/server/modules/auth/password.service.ts is the single source of truth).
 */

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export interface ChangePasswordFormProps {
  policy: PasswordPolicy;
  /** Rendered under the title; page-specific wording. */
  description?: string;
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

function policyHint(policy: PasswordPolicy): string {
  const parts: string[] = [`${policy.minLength}+ characters`];
  if (policy.requireUppercase) parts.push('an uppercase letter');
  if (policy.requireLowercase) parts.push('a lowercase letter');
  if (policy.requireNumber) parts.push('a number');
  if (policy.requireSymbol) parts.push('a symbol');
  return `Must contain ${parts.join(', ')}.`;
}

function firstPolicyProblem(password: string, policy: PasswordPolicy): string | null {
  if (password.length < policy.minLength) return policyHint(policy);
  if (policy.requireUppercase && !/[A-Z]/.test(password)) return policyHint(policy);
  if (policy.requireLowercase && !/[a-z]/.test(password)) return policyHint(policy);
  if (policy.requireNumber && !/[0-9]/.test(password)) return policyHint(policy);
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return policyHint(policy);
  return null;
}

export function ChangePasswordForm({ policy, description }: ChangePasswordFormProps) {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (newPassword !== confirmPassword) {
        setError('The two new-password fields do not match.');
        return;
      }
      const problem = firstPolicyProblem(newPassword, policy);
      if (problem) {
        setError(problem);
        return;
      }
      if (newPassword === currentPassword) {
        setError('The new password must be different from the current one.');
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const response = await apiFetch('/api/v1/auth/password', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const body: unknown = await response.json();
        const ok =
          typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;

        if (!response.ok || !ok) {
          const message = errorMessage(
            body,
            `The password was not changed (HTTP ${response.status}).`,
          );
          setError(message);
          toast({ title: 'Password not changed', description: message, variant: 'danger' });
          return;
        }

        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        toast({
          title: 'Password changed',
          description: 'Use the new password the next time you sign in.',
          variant: 'success',
        });
      } catch {
        const message = 'The password was not changed. Check your connection and try again.';
        setError(message);
        toast({ title: 'Password not changed', description: message, variant: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [confirmPassword, currentPassword, newPassword, policy],
  );

  return (
    <Card>
      <CardHeader className="p-5 pb-3">
        <CardTitle className="flex items-center gap-2">
          <KeyRound aria-hidden className="size-4 text-brand-400" />
          Change password
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 pt-2">
        <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted">
          {description ??
            'Your current password is required even though you are signed in — that is what stops a stolen session from locking you out of your own account.'}
        </p>

        <form onSubmit={submit} className="grid max-w-xl gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={busy}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={busy}
              required
            />
            <p className="text-xs text-muted">{policyHint(policy)}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="confirm-password">Repeat new password</Label>
            <Input
              id="confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={busy}
              required
            />
          </div>

          {error ? (
            <Alert variant="danger">
              <AlertTitle>Password not changed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div>
            <Button type="submit" disabled={busy || !currentPassword || !newPassword}>
              {busy ? <Spinner aria-hidden /> : null}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
