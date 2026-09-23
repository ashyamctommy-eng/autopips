import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { KycReviewer } from '@/components/admin/kyc-reviewer';
import { requireStaffPage } from '../_lib/admin-data';
import { listKycQueue } from '@/server/modules/kyc/kyc.service';
import type { KycStatusValue } from '@/types/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'KYC review',
  description: 'Manual identity review queue: documents are opened only through short-lived signed URLs.',
};

const DEFAULT_STATUS: KycStatusValue = 'PENDING';

/**
 * KYC review queue.
 *
 * The first tab's page is fetched here through `listKycQueue()` (oldest first);
 * switching tabs re-queries `GET /api/v1/admin/kyc?status=…` from the client so a
 * tab never shows rows it did not ask for.
 *
 * Documents are NOT fetched on this page: the reviewer must open a submission,
 * which calls the files endpoint, mints 300-second signed URLs and writes the
 * KYC_DOCUMENT_VIEWED audit entry that makes the access reviewable afterwards.
 */
export default async function AdminKycPage() {
  const user = await requireStaffPage();
  const initialRows = await listKycQueue({ status: DEFAULT_STATUS });

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Compliance"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'KYC review' }]}
        title="Identity review queue"
        description="Every decision here is manual and recorded: approving, rejecting or requesting more information writes an audit entry with the reviewer, the outcome and the reason."
      />

      <div className="mt-6">
        <KycReviewer
          initialRows={initialRows}
          initialStatus={DEFAULT_STATUS}
          canDecide={user.role === 'ADMIN'}
        />
      </div>
    </Section>
  );
}
