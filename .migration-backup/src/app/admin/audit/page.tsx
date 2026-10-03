import type { Metadata } from 'next';

import AdminLogsPage from '@/app/admin/logs/page';

/**
 * Alias for the admin sidebar, which links the audit trail at `/admin/audit`.
 *
 * It renders the same server component as `/admin/logs` (query parameters and
 * all) rather than redirecting, so a bookmarked filter such as
 * `/admin/audit?action=WITHDRAWAL_APPROVED` keeps working.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Audit log',
  description: 'Append-only platform audit trail with per-entry JSON detail.',
};

export default AdminLogsPage;
