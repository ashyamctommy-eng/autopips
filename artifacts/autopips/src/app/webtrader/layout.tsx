import type { Metadata } from '@/lib/next/types';
import { redirect } from '@/lib/next/navigation';

import { getSessionUser } from '@/lib/services/session';

/**
 * Bare shell for the standalone WebTrader (`/webtrader`).
 *
 * Deliberately NOT the dashboard shell. This route renders with no global top
 * bar (no profile, theme toggle or notification bell), no navigation sidebar and
 * no mobile tab bar — the terminal owns the entire viewport, which is the whole
 * point of a full-screen trading view.
 *
 * The session is still required. A signed-out visitor is redirected to the login
 * page exactly as on any other authenticated route; removing the *chrome* must
 * never mean removing the auth check.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'WebTrader',
  description: 'Full-screen trading terminal.',
  robots: { index: false, follow: false },
};

export default async function WebTraderLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return <>{children}</>;
}
