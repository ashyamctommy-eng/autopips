'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from '@/components/ui/use-toast';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Two-factor authentication management (client component).
 *
 * Enrolment is a two-step handshake with the auth API:
 *   `GET  /api/v1/auth/2fa/setup`   → a provisioning secret + a QR data URL for
 *                                     its otpauth:// URI. The secret is NOT
 *                                     persisted by that call.
 *   `POST /api/v1/auth/2fa/enable`  → the same secret plus a 6-digit code from
 *                                     the authenticator. The code is verified
 *                                     before anything is stored, so a
 *                                     half-finished enrolment cannot lock the
 *                                     account out.
 *
 * Disabling requires a *currently valid* code (a live session alone is not
 * enough). The provisioning secret lives in component state only — it is never
 * written to storage.
 */

interface Provisioning {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface TwoFactorSetupProps {
  /** `user.is2FAEnabled` from the server session. */
  enabled: boolean;
}

function isProvisioning(value: unknown): value is Provisioning {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.secret === 'string' &&
    typeof entry.otpauthUrl === 'string' &&
    typeof entry.qrDataUrl === 'string'
  );
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

export function TwoFactorSetup({ enabled }: TwoFactorSetupProps) {
  const router = useRouter();

  const [provisioning, setProvisioning] = React.useState<Provisioning | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const startSetup = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/auth/2fa/setup', {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null
          ? (body as { ok?: unknown; data?: unknown })
          : null;
      if (!response.ok || data?.ok !== true || !isProvisioning(data.data)) {
        const message = errorMessage(body, `Setup could not start (HTTP ${response.status}).`);
        setError(message);
        toast({ title: 'Setup failed', description: message, variant: 'danger' });
        return;
      }
      setProvisioning(data.data);
      setCode('');
    } catch {
      const message = 'Setup could not start. Check your connection and try again.';
      setError(message);
      toast({ title: 'Setup failed', description: message, variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }, []);

  const submitCode = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>, action: 'enable' | 'disable') => {
      event.preventDefault();
      const token = code.trim();
      if (!/^\d{6,10}$/.test(token)) {
        setError('Enter the 6-digit code from your authenticator app.');
        return;
      }
      if (action === 'enable' && !provisioning) {
        setError('Start the setup again — the provisioning secret is no longer available.');
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const response = await apiFetch(`/api/v1/auth/2fa/${action}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(
            action === 'enable'
              ? { secret: provisioning?.secret, token }
              : { token },
          ),
        });
        const body: unknown = await response.json();
        const ok =
          typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
        if (!response.ok || !ok) {
          const message = errorMessage(body, `The request was rejected (HTTP ${response.status}).`);
          setError(message);
          toast({
            title: action === 'enable' ? 'Two-factor not enabled' : 'Two-factor not disabled',
            description: message,
            variant: 'danger',
          });
          return;
        }
        toast({
          title: action === 'enable' ? 'Two-factor enabled' : 'Two-factor disabled',
          description:
            action === 'enable'
              ? 'You will be asked for a code at every sign-in.'
              : 'Your account is back to password-only sign-in.',
          variant: action === 'enable' ? 'success' : 'warn',
        });
        setProvisioning(null);
        setCode('');
        router.refresh();
      } catch {
        const message = 'The request could not be sent. Check your connection and try again.';
        setError(message);
        toast({ title: 'Request failed', description: message, variant: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [code, provisioning, router],
  );

  const copySecret = React.useCallback(async () => {
    if (!provisioning) return;
    try {
      await navigator.clipboard.writeText(provisioning.secret);
      setCopied(true);
      toast({ title: 'Secret copied', variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the secret and copy it manually.', variant: 'warn' });
    }
  }, [provisioning]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight tracking-tight text-base-100">
            Two-factor authentication
          </h2>
          <p className="mt-1 text-sm text-muted">
            A 6-digit code from an authenticator app on top of your password.
          </p>
        </div>
        <Badge variant={enabled ? 'success' : 'warn'}>
          {enabled ? <ShieldCheck aria-hidden /> : <ShieldOff aria-hidden />}
          {enabled ? 'Enabled' : 'Disabled'}
        </Badge>
      </div>

      {error ? (
        <Alert variant="danger">
          <AlertTitle>Something needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {enabled ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => void submitCode(event, 'disable')}>
          <p className="text-sm leading-relaxed text-muted">
            Disabling requires a code that is valid right now — a signed-in session on its own is not
            enough to strip the second factor off the account. Recovery codes are not issued: if you
            lose your authenticator, ask support to reset the factor, which is recorded in the audit
            trail.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="two-factor-disable-code">Authenticator code</Label>
              <Input
                id="two-factor-disable-code"
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="123456"
              />
            </div>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? <Spinner size="sm" label="Working" /> : null}
              Disable two-factor
            </Button>
          </div>
        </form>
      ) : provisioning ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader needed */}
            <img
              src={provisioning.qrDataUrl}
              alt="Two-factor setup QR code"
              width={200}
              height={200}
              className="self-start rounded-lg border border-line bg-white p-2"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <p className="text-sm leading-relaxed text-muted">
                Scan the code with your authenticator app, or enter the secret by hand. The secret is
                shown once and is not stored until you confirm a code below.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="two-factor-secret">Provisioning secret</Label>
                <div className="flex items-start gap-2">
                  <code
                    id="two-factor-secret"
                    className="min-w-0 flex-1 break-all rounded-md border border-line bg-base-950/70 px-3 py-2 font-mono text-xs text-base-100"
                  >
                    {provisioning.secret}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void copySecret()}
                    aria-label="Copy provisioning secret"
                  >
                    {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="two-factor-uri">Setup link (manual entry)</Label>
                <code
                  id="two-factor-uri"
                  className="break-all rounded-md border border-line bg-base-950/70 px-3 py-2 font-mono text-[0.68rem] text-muted"
                >
                  {provisioning.otpauthUrl}
                </code>
              </div>
            </div>
          </div>

          <Separator />

          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void submitCode(event, 'enable')}>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="two-factor-enable-code">Code from the app</Label>
              <Input
                id="two-factor-enable-code"
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="123456"
              />
            </div>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner size="sm" label="Verifying" /> : <KeyRound aria-hidden />}
              Verify and enable
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setProvisioning(null);
                setCode('');
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted">
            Two-factor authentication is off. Enrolling shows a QR code for your authenticator app
            and asks you to confirm one code before the factor is activated.
          </p>
          <div>
            <Button type="button" variant="primary" onClick={() => void startSetup()} disabled={busy}>
              {busy ? <Spinner size="sm" label="Preparing" /> : <KeyRound aria-hidden />}
              Start setup
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TwoFactorSetup;
