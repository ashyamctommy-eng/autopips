import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import type { TopbarNotification } from '@/components/layout/topbar';
import { listActivity } from '@/server/modules/account/account.service';
import { getSessionUser } from '@/server/modules/auth/session';
import type { ActivityEventDTO } from '@/types/api';

/**
 * Client dashboard shell (server component).
 *
 * This is a *server* boundary: it resolves the session from the httpOnly cookie
 * (`getSessionUser`) and reads the audit trail through the service layer. No
 * client-side fetch is involved, and nothing secret crosses into the bundle —
 * the shell below only receives a name, an email, a KYC status and real audit
 * events.
 *
 * `redirect('/login')` (not a thrown 401) is the right failure mode here: a
 * signed-out visitor is a normal state. Middleware already redirects when the
 * cookie is absent; this covers an expired/revoked token, where the cookie is
 * present but no longer resolves to a user.
 *
 * `botStatus` is deliberately NOT passed to the shell. A broker/engine status is
 * only knowable from a live socket event, and the shell has none to read at
 * render time — an absent status stays absent instead of being guessed. The
 * live trading screen renders the real indicator.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Client dashboard — equity, positions, settlements and identity verification.',
  robots: { index: false, follow: false },
};

/** How many recent events the notification bell shows. */
const NOTIFICATION_LIMIT = 6;

/**
 * Deep link for an audit action.
 *
 * Deliberately a prefix map rather than a per-action table: an action the map
 * has not seen yet still links to the overview, which is always correct.
 */
function hrefForAction(action: string): string {
  if (action.startsWith('KYC_')) return '/dashboard/kyc';
  if (action.startsWith('DEPOSIT_')) return '/dashboard/deposits';
  if (action.startsWith('WITHDRAWAL_')) return '/dashboard/withdrawals';
  if (
    action.startsWith('BOT_') ||
    action.startsWith('RISK_') ||
    action.startsWith('METAAPI_') ||
    action.startsWith('BROKER_') ||
    action.startsWith('SIGNAL_') ||
    action.startsWith('ORDER_') ||
    action.startsWith('POSITION_')
  ) {
    return '/dashboard/trading';
  }
  return '/dashboard';
}

/**
 * Audit rows → topbar notifications.
 *
 * `AuditLog` is the only event store this platform has, and it is append-only,
 * so every entry here corresponds to something that actually happened. There is
 * no per-user read receipt anywhere in the schema, which is why every entry is
 * marked read: the bell must not claim an unread count it cannot substantiate.
 */
function toNotifications(events: ActivityEventDTO[]): TopbarNotification[] {
  return events.map((event) => ({
    id: event.id,
    title: event.message,
    description: event.action,
    createdAt: event.createdAt,
    href: hrefForAction(event.action),
    read: true,
  }));
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const activity = await listActivity(user.id, NOTIFICATION_LIMIT);

  return (
    <DashboardShell
      user={{ name: user.fullName, email: user.email }}
      kycStatus={user.kycStatus}
      notifications={toNotifications(activity)}
    >
      {children}
    </DashboardShell>
  );
}
