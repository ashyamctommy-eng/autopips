import type { Metadata } from '@/lib/next/types';
import { getSessionUser } from '@/lib/services/session';
import { isSuperAdmin } from '@/lib/roles';
import TelemetryClient from './telemetry-client';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Live telemetry',
  description: 'Live worker health and ledger-backed execution outcomes.',
};

export default async function AdminTelemetryPage() {
  const user = await getSessionUser();
  if (!user || !isSuperAdmin(user.role)) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <section className="rounded-xl border border-loss/25 bg-loss/5 p-7" role="alert">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-loss">Restricted console</p>
          <h1 className="mt-3 text-2xl font-semibold text-base-100">Super Admin access required</h1>
          <p className="mt-2 text-sm text-muted">Live runtime and execution telemetry is available to Super Admin operators only.</p>
        </section>
      </main>
    );
  }
  return <TelemetryClient />;
}