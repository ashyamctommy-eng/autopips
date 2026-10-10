import type { Metadata } from '@/lib/next/types';
import { redirect } from '@/lib/next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { getSessionUser } from '@/lib/services/session';
import { getAumSummary } from '@/lib/services/admin.service';
import { countPendingWithdrawals } from './_lib/admin-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin',
  description: 'Baltimore Capital back office: assets under management, KYC review, payouts and audit trail.',
};

/**
 * Admin shell.
 *
 * Access is ADMIN or TRADING_MANAGER; a CLIENT is sent to their own dashboard and
 * an anonymous visitor to /login. Both counts in the sidebar are real queue
 * lengths, not decoration:
 *   - pendingKycCount      ← `getAumSummary()` (PENDING + UNDER_REVIEW files)
 *   - pendingWithdrawalCount ← withdrawals awaiting a decision (PENDING)
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (user.role === 'CLIENT') redirect('/dashboard');

  const [aum, pendingWithdrawalCount] = await Promise.all([
    getAumSummary(),
    countPendingWithdrawals(),
  ]);

  return (
    <AppShell
      variant="admin"
      user={{ name: user.fullName, email: user.email }}
      pendingKycCount={aum.pendingKycCount}
      pendingWithdrawalCount={pendingWithdrawalCount}
      adminRole={user.role}
      signOutHref="/admin/logout"
    >
      {children}
    </AppShell>
  );
}
