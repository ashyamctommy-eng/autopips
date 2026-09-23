import type { Metadata } from 'next';

import { LoginForm } from '@/components/auth/login-form';
import { safeNextPath } from '@/components/auth/next-path';

/**
 * `/login` — server component wrapper.
 *
 * Its only jobs are metadata and one security decision: validating the `next`
 * parameter the middleware appends (`middleware.ts` forwards
 * `?next=<pathname+search>` for an unauthenticated hit on a private area) before
 * it reaches the client form. {@link safeNextPath} accepts same-site relative
 * paths only, so a crafted `/login?next=https://evil.example` cannot turn this
 * page into an open redirect; it falls back to `/dashboard`.
 *
 * The form itself is a client island (`components/auth/login-form.tsx`) because
 * it owns input state and the password → TOTP two-step transition. No session
 * data is read here — a signed-in visitor never reaches this page, since the
 * middleware already sends them to `/dashboard`.
 */

export const metadata: Metadata = {
  title: 'Sign in',
  description:
    'Sign in to your Autopipsz account. Sessions are held in httpOnly cookies; two-factor authentication is supported.',
};

export interface LoginPageProps {
  /** Next.js passes repeated params as arrays; only the first value is used. */
  searchParams: { next?: string | string[] };
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  const rawNext = Array.isArray(searchParams.next) ? searchParams.next[0] : searchParams.next;
  return <LoginForm nextPath={safeNextPath(rawNext)} />;
}
