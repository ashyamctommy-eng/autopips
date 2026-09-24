import type { Metadata } from 'next';

import { BrokerManager } from '@/components/admin/broker-manager';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { requireStaffPage } from '../_lib/admin-data';
import { listBrokers } from '@/server/modules/admin/admin.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Broker connections',
  description: 'Deriv trading accounts, their broker-reported state and synchronisation.',
};

/**
 * Broker connections.
 *
 * Read without a latency probe: probing connects an adapter per account and
 * performs a real RPC, so it happens only when an operator asks for it (the
 * per-row "Probe latency" action). Every row therefore arrives with
 * `latencyMs: null` — "not measured", never a made-up figure.
 *
 * Only ADMINS may register, sync or remove a connection; a TRADING_MANAGER sees
 * the snapshot read-only.
 */
export default async function AdminBrokersPage() {
  const user = await requireStaffPage();
  const connections = await listBrokers({ probeLatency: false });

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Execution"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Broker connections' }]}
        title="Broker connections"
        description="Deriv accounts the platform executes on. The stored snapshot is the last value the broker actually reported; a synchronisation cycle re-reads positions, deals and investment roll-ups."
      />

      <div className="mt-6">
        <BrokerManager initialConnections={connections} canManage={user.role === 'ADMIN'} />
      </div>
    </Section>
  );
}
