import { redirect } from 'next/navigation';

import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/server/modules/auth/session';
import type { SessionUser } from '@/types/api';
import type { listAudit } from '@/server/modules/audit/audit.service';
import type { AuditLogRowView, WithdrawalRowView } from '@/components/admin/types';
import type { WithdrawalDTO } from '@/types/api';

/**
 * Server-only helpers for the admin pages.
 *
 * Kept in a private `_lib` folder (underscore = not a route). Everything here
 * runs on the server: none of it may be imported by a `'use client'` module.
 */

/**
 * The admin shell's gate, re-applied per page.
 *
 * `layout.tsx` already redirects, but a page must not depend on that: a layout
 * can be bypassed by a nested route group change, and the role check needs to be
 * visible where the data is read.
 */
export async function requireStaffPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (user.role === 'CLIENT') redirect('/dashboard');
  return user;
}

/**
 * Withdrawals awaiting an admin decision (status PENDING).
 *
 * There is no service export for this count and the list endpoint is
 * pagination-capped, so the badge cannot be derived from it without understating
 * a busy queue. This is a read-only `count()` over one indexed column — no money
 * arithmetic, nothing invented.
 */
export async function countPendingWithdrawals(): Promise<number> {
  return prisma.withdrawal.count({ where: { status: 'PENDING' } });
}

/**
 * Attach the client's email to a page of withdrawals.
 *
 * `WithdrawalDTO` deliberately carries no client identity and no `userId`, so the
 * payout reviewer would otherwise be approving an amount against nothing but a
 * payout address. One batched lookup keyed by row id — the money figures still
 * come from the payments service.
 */
export async function attachWithdrawalEmails(
  rows: WithdrawalDTO[],
): Promise<WithdrawalRowView[]> {
  if (rows.length === 0) return [];

  const owners = await prisma.withdrawal.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: { id: true, user: { select: { email: true } } },
  });
  const emailById = new Map(owners.map((row) => [row.id, row.user.email]));

  return rows.map((row) => ({ ...row, userEmail: emailById.get(row.id) ?? null }));
}

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

type AuditServiceRow = Awaited<ReturnType<typeof listAudit>>[number];

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
    createdAt: row.createdAt.toISOString(),
  };
}
