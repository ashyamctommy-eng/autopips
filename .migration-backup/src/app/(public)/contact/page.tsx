import * as React from 'react';
import type { Metadata } from 'next';
import { Clock, Lock, Scale, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { ContactForm } from '@/components/public/contact-form';
import { CONTACT_LINES } from '@/components/public/site-footer';

/**
 * Contact page.
 *
 * Server component wrapping the client form. The three contact lines are the
 * operational mailboxes for the platform domain, and the response-time note
 * states the service target rather than a guarantee.
 */

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Contact Autopipsz support, security and compliance. Send a message through the form or use the role mailboxes; every message is recorded and reviewed.',
  alternates: { canonical: '/contact' },
};

const LINE_ICONS = [ShieldCheck, Lock, Scale] as const;

export default function ContactPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-10 sm:px-6 lg:px-8">
        <PageHeader
          breadcrumb={[{ label: 'Home', href: '/' }, { label: 'Contact' }]}
          eyebrow="Contact"
          title="Talk to the operator"
          description="Questions about a deposit, an identity review, a withdrawal or the platform itself all come here. Messages are recorded in the platform's audit log, so nothing gets lost in a personal inbox."
        />
      </div>

      <Section width="wide">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardContent className="p-5 sm:p-6">
              <h2 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                Send a message
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                All fields except the subject detail are required. Validation runs in your browser and
                again on the server.
              </p>
              <div className="mt-5">
                <ContactForm />
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-5">
            <Card>
              <CardContent className="flex flex-col gap-4 p-5">
                <h2 className="text-[1rem] font-semibold leading-tight tracking-tight text-base-100">
                  Direct lines
                </h2>
                <ul className="flex flex-col gap-4">
                  {CONTACT_LINES.map((line, index) => {
                    const Icon = LINE_ICONS[index] ?? ShieldCheck;
                    return (
                      <li key={line.email} className="flex gap-3">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-base-800 text-brand-400">
                          <Icon aria-hidden className="size-4" />
                        </span>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-base-100">{line.label}</span>
                          <a
                            href={`mailto:${line.email}`}
                            className="rounded-sm text-sm text-brand-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                          >
                            {line.email}
                          </a>
                          <span className="text-xs leading-relaxed text-muted">{line.blurb}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>

            <Alert variant="info">
              <AlertTitle>
                <span className="inline-flex items-center gap-2">
                  <Clock aria-hidden className="size-4" />
                  Expected response time
                </span>
              </AlertTitle>
              <AlertDescription>
                We aim to reply within 48 hours on business days. Security reports are triaged as
                soon as they are seen, and compliance enquiries that need a reviewer may take
                longer. Response times are a service target, not a commitment.
              </AlertDescription>
            </Alert>

            <Alert variant="warn">
              <AlertTitle>Never send secrets</AlertTitle>
              <AlertDescription>
                No member of this platform will ever ask for your password, your TOTP seed, a private
                key or a wallet recovery phrase. If someone does, treat it as an attack and report it
                to the security address above.
              </AlertDescription>
            </Alert>
          </div>
        </div>
      </Section>
    </>
  );
}
