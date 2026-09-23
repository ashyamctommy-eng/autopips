'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, ScrollText, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import type { AuditLogRowView } from '@/components/admin/types';
import { cn, relativeTime } from '@/lib/utils';

/** Keys whose value must never be rendered, whatever the server logged. */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|authorization|credential|twofactor)/i;

const MAX_RENDERED_DETAILS = 4_000;

/**
 * Defence in depth for the log viewer: the audit writer already refuses to store
 * credentials, but the explorer is the one screen that prints raw JSON, so any
 * secret-looking key is masked here too. `txHash` is deliberately not matched —
 * a chain hash is public and is the proof a payout was settled.
 */
export function redactDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated: nesting too deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactDetails(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted by the admin UI]' : redactDetails(entry, depth + 1);
  }
  return out;
}

export interface AuditLogTableProps {
  rows: AuditLogRowView[];
  isLoading?: boolean;
}

/**
 * Append-only audit log table with a per-row JSON detail viewer.
 *
 * The viewer is collapsed by default (a log row can carry a large payload), and
 * the payload is redacted before it is stringified. Entries themselves are never
 * editable from any surface — the audit module exposes no update or delete.
 */
export function AuditLogTable({ rows, isLoading = false }: AuditLogTableProps) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const columns = React.useMemo<DataTableColumn<AuditLogRowView>[]>(
    () => [
      {
        key: 'createdAt',
        header: 'Timestamp',
        width: 'w-[13rem]',
        cell: (row) => (
          <div className="flex flex-col">
            <span
              suppressHydrationWarning
              className="whitespace-nowrap text-xs tabular-nums text-base-100"
            >
              {new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
            </span>
            <span suppressHydrationWarning className="text-[0.68rem] text-muted">
              {relativeTime(row.createdAt)} · UTC
            </span>
          </div>
        ),
      },
      {
        key: 'action',
        header: 'Action',
        cell: (row) => (
          <code className="whitespace-nowrap rounded border border-line bg-base-900/80 px-1.5 py-0.5 font-mono text-[0.68rem] text-brand-300">
            {row.action}
          </code>
        ),
      },
      {
        key: 'user',
        header: 'User',
        cell: (row) =>
          row.userId ? (
            <div className="flex flex-col">
              <span className="text-sm text-base-100">{row.userEmail ?? 'account removed'}</span>
              <span className="font-mono text-[0.68rem] text-muted">{row.userId}</span>
            </div>
          ) : (
            <Badge variant="outline" title="System or unauthenticated actor">
              system
            </Badge>
          ),
      },
      {
        key: 'ip',
        header: 'IP address',
        cell: (row) => (
          <span className="font-mono text-xs text-muted">{row.ipAddress ?? '—'}</span>
        ),
      },
      {
        key: 'details',
        header: 'Detail',
        cell: (row) => {
          const expanded = expandedId === row.id;
          const json = JSON.stringify(redactDetails(row.details), null, 2) ?? '';
          const truncated = json.length > MAX_RENDERED_DETAILS;
          const shown = truncated ? `${json.slice(0, MAX_RENDERED_DETAILS)}\n… truncated` : json;

          return (
            <div className="flex flex-col gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-fit"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : row.id)}
              >
                {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                {expanded ? 'Hide JSON' : 'View JSON'}
              </Button>
              {expanded ? (
                <pre className="max-h-64 max-w-[38rem] overflow-auto whitespace-pre-wrap rounded border border-line bg-base-950 p-3 font-mono text-[0.68rem] leading-relaxed text-muted">
                  {shown}
                </pre>
              ) : null}
            </div>
          );
        },
      },
    ],
    [expandedId],
  );

  return (
    <div className="flex flex-col gap-2">
      <DataTable<AuditLogRowView>
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        isLoading={isLoading}
        skeletonRows={8}
        rowClassName={(row) => cn(expandedId === row.id && 'bg-base-800/40')}
        emptyState={
          <EmptyState
            icon={ScrollText}
            title="No audit entries match"
            description="Nothing was recorded for this filter. Change or clear the action/user filter to widen the search."
          />
        }
      />
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Secret-looking keys (password, token, secret, key, credential) are masked before display. The
        audit writer never stores a MetaApi token, a password hash, a 2FA secret or a KYC object key in
        the first place.
      </p>
    </div>
  );
}

export default AuditLogTable;
