import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { getSessionUser } from '@/server/modules/auth/session';
import { getAumSummary } from '@/server/modules/admin/admin.service';
import { countPendingWithdrawals } from './_lib/admin-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin',
  description: 'Autopipsz back office: assets under management, KYC review, payouts and audit trail.',
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
      signOutHref="/admin/logout"
    >
      {children}
    </AppShell>
  );
}
