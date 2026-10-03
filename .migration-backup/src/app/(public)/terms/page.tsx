import * as React from 'react';
import type { Metadata } from 'next';

import { LegalDocumentPage } from '@/components/public/legal-document';

/**
 * Terms of Service — rendered from the versioned registry in
 * src/server/modules/legal/legal.service.ts, which is also the text whose hash
 * is stored on every registration consent record.
 */

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms governing use of the Autopipsz managed trading platform: eligibility, managed trading, deposits and withdrawals, identity verification, fees, liability and changes.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <LegalDocumentPage
      type="TERMS_OF_SERVICE"
      eyebrow="Legal"
      breadcrumbLabel="Terms"
      description="The agreement between you and the platform, including the limits of what the platform promises."
    />
  );
}
