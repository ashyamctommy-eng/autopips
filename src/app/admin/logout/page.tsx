import type { Metadata } from 'next';

import SignOut from '@/components/admin/sign-out';

export const metadata: Metadata = { title: 'Signing out' };

/**
 * Sign-out target for the admin top bar.
 *
 * It exists because `/api/v1/auth/logout` only answers POST: this page is a
 * normal navigation, and the client component inside it performs the POST that
 * revokes the session before forwarding to /login.
 */
export default function AdminLogoutPage() {
  return <SignOut />;
}
