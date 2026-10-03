import * as React from 'react';
import Link from 'next/link';

import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { findCurrentDocument, type LegalDocumentTypeValue } from '@/server/modules/legal/legal.documents';

/**
 * Renders one published legal instrument from the code-side registry
 * (`src/server/modules/legal/legal.service.ts`).
 *
 * The registry is the single source of truth: the text rendered here is exactly
 * the text whose SHA-256 is stored on every `UserConsent` row, so what a client
 * accepted can be reproduced byte-for-byte. The version and short hash are shown
 * on the page so the record is auditable from the outside.
 */

export interface LegalDocumentPageProps {
  type: LegalDocumentTypeValue;
  eyebrow: string;
  breadcrumbLabel: string;
  description: string;
}

export function LegalDocumentPage({
  type,
  eyebrow,
  breadcrumbLabel,
  description,
}: LegalDocumentPageProps) {
  const doc = findCurrentDocument(type);

  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: breadcrumbLabel }]}
          eyebrow={eyebrow}
          title={doc.title}
          description={description}
        />
      </div>

      <Section width="default">
        {/*
          Honesty guard: the registry text is an accurate, good-faith baseline
          written from what the platform actually does, but it has not been
          reviewed by counsel for every jurisdiction. Saying so on the page is
          better than presenting unreviewed text as settled terms. Remove this
          banner only after the text is reviewed and the version is bumped.
        */}
        <Alert variant="warn" className="mb-6">
          <AlertTitle>Draft for operator and legal review</AlertTitle>
          <AlertDescription>
            This is a good-faith baseline that describes how the platform actually operates. It has
            not yet been reviewed by qualified counsel for every jurisdiction in which clients are
            accepted. Have it reviewed, publish the reviewed text as a new version, and remove this
            notice before onboarding client capital.
          </AlertDescription>
        </Alert>

        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            Version <span className="font-medium text-base-100">{doc.version}</span>
          </span>
          <span aria-hidden>·</span>
          <span>Effective {doc.effectiveFrom}</span>
          <span aria-hidden>·</span>
          <span>
            Content hash{' '}
            <code className="rounded bg-base-900/60 px-1 py-0.5 text-[0.7rem] text-base-100">
              {doc.contentHash.slice(0, 16)}…
            </code>
          </span>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 p-5 text-sm leading-relaxed text-muted sm:p-6">
            {doc.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </CardContent>
        </Card>

        <p className="mt-6 text-xs leading-relaxed text-muted">
          Related:{' '}
          <Link href="/risk" className="text-brand-300 underline-offset-4 hover:underline">
            Risk disclosure
          </Link>
          ,{' '}
          <Link href="/privacy" className="text-brand-300 underline-offset-4 hover:underline">
            Privacy policy
          </Link>{' '}
          and{' '}
          <Link href="/terms" className="text-brand-300 underline-offset-4 hover:underline">
            Terms of service
          </Link>
          . Questions: compliance@autopips.pro.
        </p>
      </Section>
    </>
  );
}
