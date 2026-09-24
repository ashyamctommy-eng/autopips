import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AdminLoginForm } from '@/components/auth/admin-login-form';
import { safeConsolePath } from '@/components/auth/next-path';
import { getSessionUser } from '@/server/modules/auth/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Super admin sign-in',
  description:
    'Restricted console sign-in for Autopipsz platform operators. Administrative actions are recorded in the audit trail.',
  robots: { index: false, follow: false },
};

export interface AdminLoginPageProps {
  /** Next.js passes repeated params as arrays; only the first value is used. */
  searchParams: { next?: string | string[] };
}

/**
 * `/admin/login` — server component.
 *
 * Reachable whether or not a session exists (the middleware deliberately leaves
 * it alone): signed-out operators land here from any console URL, and a CLIENT
 * who is already signed in must still be able to switch to a staff account
 * rather than being bounced in a circle through `/admin` → `/dashboard`.
 *
 * Already-staff visitors are sent straight to the console — but the role comes
 * from the database, via `getSessionUser()`, not from the token, and the
 * destination is validated here rather than trusted from the query string.
 */
export default async function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const user = await getSessionUser();
  if (user && (user.role === 'ADMIN' || user.role === 'TRADING_MANAGER')) {
    redirect('/admin');
  }

  const rawNext = Array.isArray(searchParams.next) ? searchParams.next[0] : searchParams.next;
  return <AdminLoginForm nextPath={safeConsolePath(rawNext)} />;
}
