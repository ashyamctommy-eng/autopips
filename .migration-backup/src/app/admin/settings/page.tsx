import type { Metadata } from 'next';
import { KeyRound, Lock, SlidersHorizontal } from 'lucide-react';

import { ChangePasswordForm } from '@/components/dashboard/change-password-form';
import { PlatformSettingsForm } from '@/components/admin/platform-settings-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { PASSWORD_POLICY } from '@/server/modules/auth/password.service';
import { listAdminSettings } from '@/server/modules/settings/settings.service';
import { requireStaffPage } from '../_lib/admin-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Platform settings',
  description: 'Payment provider credentials and platform configuration, editable without a redeploy.',
};

/**
 * Admin → Platform settings (server component).
 *
 * Two jobs:
 *   1. the operator-editable platform settings (payment provider keys etc.);
 *   2. the signed-in administrator's own password — the bootstrap admin is
 *      created from an environment variable at deploy time, so this is where that
 *      password gets replaced with one only the operator knows.
 *
 * The page is reachable by ADMIN and TRADING_MANAGER (it is part of the back
 * office), but the settings API is ADMIN-only — a manager who lands here gets an
 * explanation instead of a form that would 403 on save. The value is read on the
 * server: no credential is ever fetched by the browser.
 */
export default async function AdminSettingsPage() {
  const user = await requireStaffPage();
  const settings = await listAdminSettings();
  const isAdmin = user.role === 'ADMIN';

  const fromConsole = settings.filter((s) => s.source === 'console').length;
  const unset = settings.filter((s) => s.source === 'unset');

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Back office"
        title="Platform settings"
        description="Provider credentials and operational switches. Values set here override the service variables of the same name — no redeploy required."
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Platform settings' }]}
      />

      {!isAdmin ? (
        <Alert variant="warn">
          <AlertTitle>Read-only for your role</AlertTitle>
          <AlertDescription>
            Platform settings can only be changed by an ADMIN. You are signed in as{' '}
            {user.role.replace(/_/g, ' ').toLowerCase()}, so this page is shown for reference only.
          </AlertDescription>
        </Alert>
      ) : null}

      {unset.length > 0 ? (
        <Alert variant="warn">
          <AlertTitle>
            {unset.length} setting{unset.length === 1 ? '' : 's'} without a value
          </AlertTitle>
          <AlertDescription>
            {unset.map((s) => s.label).join(', ')} — the features that depend on{' '}
            {unset.length === 1 ? 'it' : 'them'} cannot work until a value is set here or in the
            service variables.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal aria-hidden className="size-4 text-brand-400" />
            Payment provider &amp; broker credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          <p className="mb-1 max-w-3xl text-sm leading-relaxed text-muted">
            {fromConsole === 0
              ? 'Nothing has been overridden yet: every value below is coming from this service’s environment variables.'
              : `${fromConsole} value${fromConsole === 1 ? '' : 's'} come from this console; the rest come from the service environment.`}{' '}
            Secrets are encrypted at rest with CREDENTIAL_ENCRYPTION_KEY and are never displayed in
            full — not here, not in the audit log.
          </p>

          {isAdmin ? (
            <PlatformSettingsForm initial={settings} />
          ) : (
            <ul className="mt-4 grid gap-3">
              {settings.map((setting) => (
                <li key={setting.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-base-100">{setting.label}</span>
                  <span className="font-mono text-xs text-muted">{setting.display ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Alert variant="info">
        <Lock aria-hidden />
        <AlertTitle>What is deliberately not editable here</AlertTitle>
        <AlertDescription>
          <span className="block">
            JWT_SECRET, CREDENTIAL_ENCRYPTION_KEY, DATABASE_URL, REDIS_URL stay in the service
            variables, because rotating them invalidates live sessions, stored credentials or the
            running deployment itself — they belong to a deploy, not a form. The same is true for
            the risk limits the bot enforces.
          </span>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-brand-400" />
            Your administrator password
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted">
            Signed in as <span className="text-base-100">{user.email}</span>. If this account was
            created from BOOTSTRAP_ADMIN_PASSWORD, that password is sitting in the service variables
            — change it here, then remove the variable.
          </p>
          <ChangePasswordForm
            policy={PASSWORD_POLICY}
            description="Changing it takes effect on your next sign-in. Your current password is required even though you are already signed in."
          />
        </CardContent>
      </Card>
    </Section>
  );
}
