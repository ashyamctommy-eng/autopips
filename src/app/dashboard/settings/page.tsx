import Link from 'next/link';
import { Info, ShieldCheck, UserCog } from 'lucide-react';

import { ChangePasswordForm } from '@/components/dashboard/change-password-form';
import { SignOutButton } from '@/components/dashboard/sign-out-button';
import { TwoFactorSetup } from '@/components/dashboard/two-factor-setup';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PASSWORD_POLICY } from '@/server/modules/auth/password.service';
import { requireSessionUser } from '@/server/modules/auth/session';

/**
 * Profile & security (server component).
 *
 * Reads the session user (email, name, country, role, join date, KYC status,
 * 2FA state) and renders two client widgets: the two-factor manager and the
 * sign-out action. Nothing on this page is client-fetched — the session is
 * resolved from the httpOnly cookie on the server.
 */

export const dynamic = 'force-dynamic';

function roleLabel(role: string): string {
  return role.replace(/_/g, ' ').toLowerCase();
}

export default async function DashboardSettingsPage() {
  const user = await requireSessionUser();

  const joined = new Date(user.createdAt);
  const joinedLabel = Number.isNaN(joined.getTime())
    ? '—'
    : joined.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Account"
        title="Profile & security"
        description="Your account record as the platform holds it, plus the second factor that protects it."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Settings' }]}
      />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
          <CardTitle className="flex items-center gap-2">
            <UserCog aria-hidden className="size-4 text-brand-400" />
            Profile
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{roleLabel(user.role)}</Badge>
            <StatusBadge status={user.kycStatus} kind="kyc" showIcon />
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 p-5 pt-2 sm:grid-cols-2">
          <Detail label="Email" value={user.email} />
          <Detail label="Full name" value={user.fullName} />
          <Detail label="Country" value={user.country || '—'} />
          <Detail label="Member since" value={joinedLabel} />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wide text-muted">Identity verification</span>
            <span className="flex items-center gap-2">
              <StatusBadge status={user.kycStatus} kind="kyc" showIcon />
              <Button asChild variant="link" size="sm">
                <Link href="/dashboard/kyc">Open</Link>
              </Button>
            </span>
          </div>
          <Detail label="Account ID" value={user.id} mono />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4 text-brand-400" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 p-5 pt-0">
          <TwoFactorSetup enabled={user.is2FAEnabled} />

          <Separator />

          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-medium text-base-100">Session</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Your session is held in httpOnly cookies, so no script on this page can read it.
                Signing out revokes the session server-side and clears both cookies.
              </p>
            </div>
            <div>
              <SignOutButton />
            </div>
          </div>
        </CardContent>
      </Card>

      <ChangePasswordForm policy={PASSWORD_POLICY} />

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Email address, name and country changes are handled by support: they are compliance-relevant
        fields that must not be self-editable without a review trail.
      </p>
    </Section>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={mono ? 'break-all font-mono text-xs text-base-100' : 'text-sm text-base-100'}>
        {value}
      </span>
    </div>
  );
}
