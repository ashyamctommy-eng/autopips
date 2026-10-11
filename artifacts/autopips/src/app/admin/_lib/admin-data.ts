import { redirect } from '@/lib/next/navigation';
import { remote } from '@/lib/rpc';
import { getSessionUser } from '@/lib/services/session';
import type { SessionUser } from '@/types/api';
import type { AuditLogRowView, WithdrawalRowView } from '@/components/admin/types';
import type { WithdrawalDTO } from '@/types/api';

/**
 * Data helpers for the admin pages. The prisma-backed ones run on the server
 * and are reached through the migration RPC endpoint (staff-gated there).
 *
 * The RPC module is spelled out literally at each `remote(...)` call: the
 * endpoint serves only a closed allow-list, and
 * `artifacts/api-server/tests/rpc-allowlist.test.ts` statically checks every call
 * site against it. A call whose module name comes from a variable cannot be
 * checked, so it does not pass that guard.
 */

export async function requireStaffPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (user.role === 'CLIENT') redirect('/dashboard');
  return user;
}

export const countPendingWithdrawals: () => Promise<number> = remote('app/admin/_lib/admin-data', 'countPendingWithdrawals');

export const attachWithdrawalEmails: (rows: WithdrawalDTO[]) => Promise<WithdrawalRowView[]> = remote(
  'app/admin/_lib/admin-data',
  'attachWithdrawalEmails',
);

/** Awaiting a decision or a settlement — everything that is not FINISHED. */
export function isOpenWithdrawal(row: WithdrawalRowView): boolean {
  return row.status !== 'FINISHED' && row.status !== 'REFUNDED';
}

/** Non-FINISHED rows first (oldest first), finished settlement history last. */
export function sortWithdrawalQueue(rows: WithdrawalRowView[]): WithdrawalRowView[] {
  return [...rows].sort((a, b) => {
    const aOpen = isOpenWithdrawal(a);
    const bOpen = isOpenWithdrawal(b);
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return aOpen ? aTime - bTime : bTime - aTime;
  });
}

type AuditServiceRow = any;

/** The audit row as the log explorer needs it — plain, serialisable, no Prisma types. */
export function toAuditRowView(row: AuditServiceRow): AuditLogRowView {
  const details =
    row.details !== null && typeof row.details === 'object' && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : { value: row.details };

  return {
    id: row.id,
    action: row.action,
    userId: row.userId,
    userEmail: row.user?.email ?? null,
    userFullName: row.user?.fullName ?? null,
    ipAddress: row.ipAddress,
    details,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
