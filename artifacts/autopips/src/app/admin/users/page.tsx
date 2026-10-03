import type { Metadata } from '@/lib/next/types';

import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { UserDirectory } from '@/components/admin/user-directory';
import { requireStaffPage } from '../_lib/admin-data';
import { isAdminRole, isSuperAdmin } from '@/lib/roles';
import { listUsers } from '@/lib/services/admin.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Users',
  description: 'Client and staff directory with roles, KYC state and per-user capital.',
};

/**
 * User directory.
 *
 * The first page is read through `listUsers()` — one user query plus a fixed
 * number of batch aggregates for the whole page (never one accounting query per
 * row). Filtering and cursor pagination then re-query the admin API from the
 * client, which keeps this server render cheap.
 */
export default async function AdminUsersPage() {
  const user = await requireStaffPage();
  const { items, nextCursor } = await listUsers({ take: 25 });

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Administration"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Users' }]}
        title="Users"
        description="Every account with its role, identity state and capital. Equity here is computed with the same formula the client sees on their own dashboard."
      />

      <div className="mt-6">
        <UserDirectory
          initialItems={items}
          initialNextCursor={nextCursor}
          canChangeRole={isAdminRole(user.role)}
          canManageBalance={isSuperAdmin(user.role)}
          currentUserId={user.id}
        />
      </div>
    </Section>
  );
}
