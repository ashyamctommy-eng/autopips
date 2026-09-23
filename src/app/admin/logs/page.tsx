import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';

import { AdminOnlyNotice } from '@/components/admin/admin-only-notice';
import { AuditLogTable } from '@/components/admin/log-table';
import { LogFilters } from '@/components/admin/log-filters';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { requireStaffPage, toAuditRowView } from '../_lib/admin-data';
import { AUDIT, listAudit } from '@/server/modules/audit/audit.service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Audit log',
  description: 'Append-only platform audit trail with per-entry JSON detail.',
};

const PAGE_SIZE = 50;

/** `?a=1&a=2` arrives as an array; take the first value and ignore the rest. */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function buildHref(params: {
  action?: string;
  userId?: string;
  cursor?: string;
}): string {
  const search = new URLSearchParams();
  if (params.action) search.set('action', params.action);
  if (params.userId) search.set('userId', params.userId);
  if (params.cursor) search.set('cursor', params.cursor);
  const query = search.toString();
  return query === '' ? '/admin/logs' : `/admin/logs?${query}`;
}

/**
 * Audit log explorer.
 *
 * Filters live in the URL (`action`, `userId`, `cursor`) so any view an
 * investigator reaches can be pasted into a ticket and re-opened later. The rows
 * are the stored audit entries, newest first — the table renders them verbatim
 * and the detail viewer prints the recorded JSON (with secret-looking keys
 * masked).
 *
 * ADMIN-only: audit rows carry other users' identity and money context.
 */
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams?: { action?: string | string[]; userId?: string | string[]; cursor?: string | string[] };
}) {
  const user = await requireStaffPage();

  const action = firstValue(searchParams?.action) ?? null;
  const userId = firstValue(searchParams?.userId) ?? null;
  const cursor = firstValue(searchParams?.cursor) ?? null;

  if (user.role !== 'ADMIN') {
    return (
      <Section width="wide">
        <PageHeader
          eyebrow="Governance"
          breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Audit log' }]}
          title="Audit log"
        />
        <div className="mt-6">
          <AdminOnlyNotice feature="the audit log" />
        </div>
      </Section>
    );
  }

  // One extra row tells us whether an older page exists without a count query.
  const rows = await listAudit({
    ...(action ? { action } : {}),
    ...(userId ? { userId } : {}),
    ...(cursor ? { cursor } : {}),
    take: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  const actionOptions = [...Object.values(AUDIT)].sort();

  return (
    <Section width="wide">
      <PageHeader
        eyebrow="Governance"
        breadcrumb={[{ label: 'Admin', href: '/admin' }, { label: 'Audit log' }]}
        title="Audit log"
        description="Every money, identity, role and broker transition is written here. The table is append-only by convention: the audit module exposes no update and no delete."
      />

      <div className="mt-6 flex flex-col gap-4">
        <LogFilters
          actions={actionOptions}
          basePath="/admin/logs"
          action={action}
          userId={userId}
        />

        <Alert variant="info" icon={ScrollText}>
          <AlertTitle>Entries are append-only</AlertTitle>
          <AlertDescription>
            Rows are never edited or removed from the application. Each entry records the action, the
            acting user (or “system”), the request IP where available, and the recorded detail object.
            {action || userId ? (
              <>
                {' '}
                Filtered view:{' '}
                {action ? <code className="font-mono text-xs">{action}</code> : 'any action'}
                {userId ? (
                  <>
                    {' '}
                    · actor <code className="font-mono text-xs">{userId}</code>
                  </>
                ) : null}
                . {page.length} entr{page.length === 1 ? 'y' : 'ies'} on this page.
              </>
            ) : (
              <> Showing the newest {page.length} entries.</>
            )}
          </AlertDescription>
        </Alert>

        <AuditLogTable rows={page.map(toAuditRowView)} />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-sm">Paging</CardTitle>
              <CardDescription className="text-xs">
                Cursor pagination on the audit row id — newest first. The cursor is the last row of the
                page you are looking at, so no entry is skipped while new ones arrive.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" disabled={cursor === null}>
                <Link href={buildHref({ action: action ?? undefined, userId: userId ?? undefined })}>
                  <ChevronLeft aria-hidden />
                  Newest
                </Link>
              </Button>
              {nextCursor ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={buildHref({
                      action: action ?? undefined,
                      userId: userId ?? undefined,
                      cursor: nextCursor,
                    })}
                  >
                    Older
                    <ChevronRight aria-hidden />
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Older
                  <ChevronRight aria-hidden />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted">
              {cursor === null
                ? 'Viewing the newest entries.'
                : 'Viewing an older page — use “Newest” to return to the head of the log.'}
            </p>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}
