'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, RefreshCw, Search, ShieldCheck, Users } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { Usd } from '@/components/shared/money';
import { UserRoleControl } from '@/components/admin/user-role-control';
import { adminRequest, buildQuery, errorMessage } from '@/components/admin/api-client';
import type { AdminUserRowView, StaffRole } from '@/components/admin/types';
import { relativeTime } from '@/lib/utils';
import { KYC_STATUS_META } from '@/lib/contracts';
import type { KycStatusValue } from '@/types/api';

const PAGE_SIZE = 25;
const ALL = 'ALL';

export interface UserDirectoryProps {
  initialItems: AdminUserRowView[];
  initialNextCursor: string | null;
  canChangeRole: boolean;
  currentUserId: string;
}

interface UserPage {
  items: AdminUserRowView[];
  nextCursor: string | null;
}

const ROLE_LABEL: Record<StaffRole, string> = {
  CLIENT: 'Client',
  ADMIN: 'Administrator',
  TRADING_MANAGER: 'Trading manager',
};

/**
 * Admin user directory.
 *
 * Cursor pagination over `GET /api/v1/admin/users` (the cursor is the last row
 * id of the page). Searches by email/full name, filters by role and KYC status.
 *
 * The endpoint selects no credential column at all — no password hash, no 2FA
 * secret, no document key — so none of them can appear here even by accident.
 */
export function UserDirectory({
  initialItems,
  initialNextCursor,
  canChangeRole,
  currentUserId,
}: UserDirectoryProps) {
  const router = useRouter();
  const [items, setItems] = React.useState<AdminUserRowView[]>(initialItems);
  const [nextCursor, setNextCursor] = React.useState<string | null>(initialNextCursor);
  const [trail, setTrail] = React.useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [searchInput, setSearchInput] = React.useState('');
  const [query, setQuery] = React.useState({ search: '', role: ALL as StaffRole | typeof ALL, kycStatus: ALL as KycStatusValue | typeof ALL });

  const load = React.useCallback(
    async (nextTrail: (string | undefined)[], index: number, current: typeof query) => {
      setLoading(true);
      setError(null);
      try {
        const page = await adminRequest<UserPage>(
          `/api/v1/admin/users${buildQuery({
            search: current.search,
            role: current.role === ALL ? undefined : current.role,
            kycStatus: current.kycStatus === ALL ? undefined : current.kycStatus,
            take: PAGE_SIZE,
            cursor: nextTrail[index],
          })}`,
        );
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setTrail(nextTrail);
        setPageIndex(index);
      } catch (caught) {
        setError(errorMessage(caught));
        setItems([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const applyFilters = (next: Partial<typeof query>) => {
    const merged = { ...query, ...next };
    setQuery(merged);
    void load([undefined], 0, merged);
  };

  const columns = React.useMemo<DataTableColumn<AdminUserRowView>[]>(
    () => [
      {
        key: 'email',
        header: 'Email',
        cell: (row) => (
          <div className="flex flex-col">
            <span className="text-sm text-base-100">{row.email}</span>
            <span className="text-xs text-muted">{row.id}</span>
          </div>
        ),
      },
      {
        key: 'name',
        header: 'Name',
        cell: (row) => <span className="text-sm text-base-100">{row.fullName}</span>,
      },
      {
        key: 'country',
        header: 'Country',
        cell: (row) => <span className="text-sm text-muted">{row.country}</span>,
      },
      {
        key: 'role',
        header: 'Role',
        cell: (row) => (
          <UserRoleControl
            user={row}
            canChangeRole={canChangeRole}
            isSelf={row.id === currentUserId}
            onChanged={() => {
              // Re-read the page from the API, then let the server re-render the
              // shell (a role change can move the active-client count on /admin).
              void load(trail, pageIndex, query);
              router.refresh();
            }}
          />
        ),
      },
      {
        key: 'kyc',
        header: 'KYC',
        cell: (row) => <StatusBadge status={row.kycStatus} kind="kyc" showIcon />,
      },
      {
        key: '2fa',
        header: '2FA',
        cell: (row) =>
          row.is2FAEnabled ? (
            <Badge variant="success">On</Badge>
          ) : (
            <Badge variant="outline" title="No second factor enrolled — not a secret this screen can read">
              Off
            </Badge>
          ),
      },
      {
        key: 'joined',
        header: 'Joined',
        cell: (row) => (
          <span suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(row.createdAt)}
          </span>
        ),
      },
      {
        key: 'capital',
        header: 'Capital deployed',
        align: 'right',
        cell: (row) => <Usd value={row.capitalUsd} tone="neutral" className="text-sm" />,
      },
      {
        key: 'equity',
        header: 'Equity',
        align: 'right',
        cell: (row) => <Usd value={row.equity} tone="neutral" className="text-sm" />,
      },
    ],
    [load, canChangeRole, currentUserId, trail, pageIndex, query, router],
  );

  const kycOptions = Object.keys(KYC_STATUS_META) as KycStatusValue[];

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-xl border border-line bg-base-850/60 p-4 lg:flex-row lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters({ search: searchInput.trim() });
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="user-search">Search</Label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              id="user-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Email or full name"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-full flex-col gap-1.5 lg:w-48">
          <Label htmlFor="user-role-filter">Role</Label>
          <Select
            value={query.role}
            onValueChange={(value) => applyFilters({ role: value as StaffRole | typeof ALL })}
          >
            <SelectTrigger id="user-role-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All roles</SelectItem>
              {(Object.keys(ROLE_LABEL) as StaffRole[]).map((role) => (
                <SelectItem key={role} value={role}>
                  {ROLE_LABEL[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-full flex-col gap-1.5 lg:w-52">
          <Label htmlFor="user-kyc-filter">KYC status</Label>
          <Select
            value={query.kycStatus}
            onValueChange={(value) => applyFilters({ kycStatus: value as KycStatusValue | typeof ALL })}
          >
            <SelectTrigger id="user-kyc-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {kycOptions.map((status) => (
                <SelectItem key={status} value={status}>
                  {KYC_STATUS_META[status]?.label ?? status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={loading}>
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setSearchInput('');
              applyFilters({ search: '', role: ALL, kycStatus: ALL });
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {error ? (
        <Alert variant="danger">
          <AlertTitle>Could not load users</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable<AdminUserRowView>
        columns={columns}
        rows={items}
        getRowKey={(row) => row.id}
        isLoading={loading && items.length === 0}
        skeletonRows={6}
        caption={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {items.length} user{items.length === 1 ? '' : 's'} on this page · cursor pagination
              (the cursor is the last row id), newest first.
            </span>
            <span className="text-muted">
              Password hashes and 2FA secrets are never selected by the API and never sent to this
              page.
            </span>
          </span>
        }
        emptyState={
          <EmptyState
            icon={Users}
            title="No users match these filters"
            description="Widen the search or clear the role/KYC filters. Users appear here as soon as they register."
          />
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">
          Page {pageIndex + 1} · showing {items.length} row{items.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          {loading ? <RefreshCw aria-hidden className="size-4 animate-spin text-muted" /> : null}
          <Button
            variant="outline"
            size="sm"
            disabled={pageIndex === 0 || loading}
            onClick={() => void load(trail, pageIndex - 1, query)}
          >
            <ChevronLeft aria-hidden />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={nextCursor === null || loading}
            onClick={() => {
              if (!nextCursor) return;
              const nextTrail = [...trail, nextCursor];
              void load(nextTrail, pageIndex + 1, query);
            }}
          >
            Next
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Role changes are audited as ADMIN_USER_ROLE_CHANGED with the previous and new role. A user&apos;s
        existing access token keeps its old role until it refreshes, and the last remaining ADMIN can
        never be demoted.
      </p>
    </div>
  );
}

export default UserDirectory;
