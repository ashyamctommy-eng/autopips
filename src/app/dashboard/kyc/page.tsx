import { FileCheck2, Info, ShieldCheck } from 'lucide-react';

import { KycForm } from '@/components/dashboard/kyc-form';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KYC_STATUS_META } from '@/lib/contracts';
import { cn } from '@/lib/utils';
import { getMyKyc } from '@/server/modules/kyc/kyc.service';
import { requireSessionUser } from '@/server/modules/auth/session';
import type { KycStatusValue } from '@/types/api';

/**
 * Identity verification (server component).
 *
 * Reads the caller's own profile through `getMyKyc()` — a DTO with a masked
 * document number and no storage keys — and renders the real state machine:
 *
 *   Not submitted → Pending review → Under review → Verified
 *                                            ↘ Action required / Rejected
 *
 * Documents are encrypted at rest and stored by the platform itself, and are
 * opened only by a compliance officer through an internal, audited admin-only
 * route. Nothing here (and nothing in the form below) renders a document, a
 * thumbnail or a link to one.
 */

export const dynamic = 'force-dynamic';

const STATUS_SEQUENCE: KycStatusValue[] = ['NOT_SUBMITTED', 'PENDING', 'UNDER_REVIEW', 'APPROVED'];

const DOCUMENT_LABELS: Record<string, string> = {
  idFront: 'Identity document (front)',
  idBack: 'Identity document (back)',
};

export default async function DashboardKycPage() {
  const user = await requireSessionUser();
  const profile = await getMyKyc(user.id);

  const status: KycStatusValue = profile?.status ?? user.kycStatus;
  const meta = KYC_STATUS_META[status] ?? KYC_STATUS_META.NOT_SUBMITTED;
  const currentIndex = STATUS_SEQUENCE.indexOf(status);
  const needsAttention = status === 'REJECTED' || status === 'ADDITIONAL_INFO_REQUIRED';

  return (
    <Section width="default" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Compliance"
        title="Identity verification"
        description="Verification is a manual review by a compliance officer. Deposits, withdrawals and capital deployment stay locked until your file is approved."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Identity' }]}
      />

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <CardTitle>Current status</CardTitle>
            <p className="mt-1 text-sm text-muted">{meta.blurb}</p>
          </div>
          <StatusBadge status={status} kind="kyc" showIcon />
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-5 pt-2">
          <ol className="grid gap-3 sm:grid-cols-4">
            {STATUS_SEQUENCE.map((entry, index) => {
              const reached = currentIndex >= index;
              return (
                <li
                  key={entry}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg border p-3',
                    reached ? 'border-brand/30 bg-brand/[0.06]' : 'border-line bg-base-900/40',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Badge variant={reached ? 'brand' : 'outline'}>{index + 1}</Badge>
                    <span className={reached ? 'text-base-100' : 'text-muted'}>
                      {KYC_STATUS_META[entry]?.label ?? entry}
                    </span>
                  </span>
                  <span className="text-xs leading-relaxed text-muted">
                    {KYC_STATUS_META[entry]?.blurb ?? ''}
                  </span>
                </li>
              );
            })}
          </ol>

          {needsAttention ? (
            <Alert variant={status === 'REJECTED' ? 'danger' : 'warn'}>
              <AlertTitle>{meta.label}</AlertTitle>
              <AlertDescription>
                {profile?.rejectionReason
                  ? profile.rejectionReason
                  : 'No reason was recorded with this decision. Contact support for the detail.'}
              </AlertDescription>
            </Alert>
          ) : null}

          {profile ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Detail label="Legal name" value={profile.legalName} />
              <Detail label="Date of birth" value={profile.dob} />
              <Detail label="Document type" value={profile.idType.replace(/_/g, ' ')} />
              <Detail label="Document number" value={profile.idNumberMasked} mono />
              <Detail label="Address" value={profile.address} className="sm:col-span-2" />
              <Detail
                label="Submitted"
                value={new Date(profile.createdAt).toLocaleString('en-GB')}
              />
              <Detail
                label="Reviewed"
                value={profile.reviewedAt ? new Date(profile.reviewedAt).toLocaleString('en-GB') : '—'}
              />
            </div>
          ) : (
            <p className="text-sm text-muted">
              No file has been submitted yet. Nothing has been recorded for this account.
            </p>
          )}

          {profile ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs uppercase tracking-wide text-muted">Documents on file</span>
              <ul className="grid gap-2 sm:grid-cols-2">
                {profile.documents.map((document) => (
                  <li
                    key={document.kind}
                    className="flex items-center gap-2 rounded-lg border border-line bg-base-900/40 px-3 py-2 text-sm"
                  >
                    <FileCheck2
                      aria-hidden
                      className={cn('size-4', document.uploaded ? 'text-profit-400' : 'text-muted')}
                    />
                    <span className="min-w-0 flex-1 truncate text-base-100">
                      {DOCUMENT_LABELS[document.kind] ?? document.kind}
                    </span>
                    <Badge variant={document.uploaded ? 'success' : 'outline'}>
                      {document.uploaded ? 'Stored' : 'Not provided'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            Your documents are encrypted at rest and stored by the platform itself. They are opened
            only by a compliance officer through an internal, admin-only route, and every access is
            written to the audit trail — which is why this page shows you that a document exists
            without ever displaying it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-5 pb-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4 text-brand-400" />
            {profile ? 'Replace or complete your submission' : 'Submit your identity documents'}
          </CardTitle>
          <p className="text-xs leading-relaxed text-muted">
            Accepted formats: JPEG, PNG, WebP or PDF, up to 10 MB each. Resubmitting resets the
            review state, because a fresh file has to be reviewed from scratch.
          </p>
        </CardHeader>
        <CardContent className="p-5 pt-2">
          <KycForm initial={profile} />
        </CardContent>
      </Card>
    </Section>
  );
}

function Detail({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      {/* `min-w-0` keeps a long unbroken value (a legal name, an id) inside its
          grid cell instead of widening the track and the page on a phone. */}
      <span className={cn('break-words text-sm text-base-100', mono && 'break-all font-mono')}>
        {value}
      </span>
    </div>
  );
}
