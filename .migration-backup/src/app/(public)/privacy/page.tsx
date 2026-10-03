import * as React from 'react';
import type { Metadata } from 'next';

import { LegalDocumentPage } from '@/components/public/legal-document';

/**
 * Privacy Policy — rendered from the versioned registry in
 * src/server/modules/legal/legal.service.ts, which is also the text whose hash
 * is stored on every registration consent record.
 */

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What personal data Autopipsz collects, why, how identity documents are stored, who it is shared with, how long it is kept and your rights.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <LegalDocumentPage
      type="PRIVACY_POLICY"
      eyebrow="Legal"
      breadcrumbLabel="Privacy"
      description="What we collect, why we collect it, how identity documents are protected, and how long we keep things."
    />
  );
}
