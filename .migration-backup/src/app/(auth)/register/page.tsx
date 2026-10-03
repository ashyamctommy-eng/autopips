import type { Metadata } from 'next';

import { RegisterForm } from '@/components/auth/register-form';

/**
 * `/register` — server component wrapper.
 *
 * Metadata plus the client form. There is nothing to read on the server: the
 * country list is a local constant, the password policy is mirrored client-side,
 * and `POST /api/v1/auth/register` — which is what actually creates the account —
 * is called over fetch. The server never renders a form field from request data,
 * so no user input is reflected into the HTML.
 */

export const metadata: Metadata = {
  title: 'Open an account',
  description:
    'Open an Autopipsz account: email, password and country. Identity verification, deposits and capital allocation follow after you sign in.',
};

export default function RegisterPage() {
  return <RegisterForm />;
}
