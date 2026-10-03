import { MessagesFeed } from '@/components/dashboard/messages-feed';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { listActivity, listInvestments } from '@/lib/services/account.service';
import { requireSessionUser } from '@/lib/services/session';

/**
 * Messages (server component).
 *
 * The account's trading log: what the engine opened, closed and decided. The
 * audit trail is read through the service layer (append-only, so every row is
 * something that happened) and handed to the live feed, which merges the socket
 * stream over it.
 *
 * The active investment is resolved only to mirror that room on the socket; the
 * stored rows are account-wide either way, so a client with no investment still
 * sees their history rather than an empty page.
 */

export const dynamic = 'force-dynamic';

/** Audit rows read as the feed's initial (stored) state. */
const MESSAGE_TAKE = 100;

export default async function DashboardMessagesPage() {
  const user = await requireSessionUser();

  const [activity, investments] = await Promise.all([
    listActivity(user.id, MESSAGE_TAKE),
    listInvestments(user.id),
  ]);

  const activeInvestment =
    investments.find((investment) => investment.status === 'ACTIVE') ??
    investments.find((investment) => investment.status === 'PAUSED') ??
    null;

  return (
    <Section width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Messages"
        description="Trade and strategy messages from the trading engine — position opens, closures with their realised P/L, risk decisions and bot status."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Messages' }]}
      />

      <MessagesFeed
        investmentId={activeInvestment?.id ?? null}
        initialEvents={activity}
      />
    </Section>
  );
}
