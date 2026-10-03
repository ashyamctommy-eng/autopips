'use client';

import * as React from 'react';

import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Usd } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { assetMeta } from '@/lib/contracts';
import { relativeTime } from '@/lib/utils';
import type { DepositDTO, WithdrawalDTO } from '@/types/api';

/**
 * Compact settlement tables for the wallet overview.
 *
 * The wallet is a *summary* surface: it renders the same rows, the same
 * `StatusBadge` treatment and the same `EmptyState` copy the full deposits and
 * withdrawals pages use, only narrowed to the columns a glance needs. Column
 * definitions must live in a client module because `DataTable` takes render
 * functions; everything it displays is the untouched `DepositDTO` /
 * `WithdrawalDTO` the payments service returned — no figure is recalculated
 * here.
 */

export interface WalletDepositListProps {
  items: DepositDTO[];
}

export function WalletDepositList({ items }: WalletDepositListProps) {
  const columns = React.useMemo<DataTableColumn<DepositDTO>[]>(
    () => [
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (deposit) => <Usd value={deposit.amountUsd} tone="neutral" />,
      },
      {
        key: 'currency',
        header: 'Currency',
        cell: (deposit) => {
          const meta = assetMeta(deposit.cryptoCurrency);
          return (
            <span className="flex flex-col">
              <span className="text-base-100">{meta.symbol}</span>
              <span className="text-xs text-muted">{meta.network}</span>
            </span>
          );
        },
      },
      {
        key: 'status',
        header: 'Status',
        cell: (deposit) => <StatusBadge status={deposit.status} kind="payment" showIcon />,
      },
      {
        key: 'created',
        header: 'Requested',
        align: 'right',
        cell: (deposit) => (
          <time
            dateTime={deposit.createdAt}
            suppressHydrationWarning
            className="text-xs tabular-nums text-muted"
          >
            {relativeTime(deposit.createdAt)}
          </time>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<DepositDTO>
      columns={columns}
      rows={items}
      getRowKey={(deposit) => deposit.id}
      emptyState={
        <EmptyState
          size="sm"
          title="No deposits yet"
          description="A deposit appears here as soon as the provider issues an address for it."
        />
      }
    />
  );
}

export interface WalletWithdrawalListProps {
  items: WithdrawalDTO[];
}

export function WalletWithdrawalList({ items }: WalletWithdrawalListProps) {
  const columns = React.useMemo<DataTableColumn<WithdrawalDTO>[]>(
    () => [
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (withdrawal) => <Usd value={withdrawal.amountUsd} tone="neutral" />,
      },
      {
        key: 'currency',
        header: 'Currency',
        cell: (withdrawal) => {
          const meta = assetMeta(withdrawal.cryptoCurrency);
          return (
            <span className="flex flex-col">
              <span className="text-base-100">{meta.symbol}</span>
              <span className="text-xs text-muted">{meta.network}</span>
            </span>
          );
        },
      },
      {
        key: 'status',
        header: 'Status',
        cell: (withdrawal) => <StatusBadge status={withdrawal.status} kind="payment" showIcon />,
      },
      {
        key: 'created',
        header: 'Requested',
        align: 'right',
        cell: (withdrawal) => (
          <time
            dateTime={withdrawal.createdAt}
            suppressHydrationWarning
            className="text-xs tabular-nums text-muted"
          >
            {relativeTime(withdrawal.createdAt)}
          </time>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<WithdrawalDTO>
      columns={columns}
      rows={items}
      getRowKey={(withdrawal) => withdrawal.id}
      emptyState={
        <EmptyState
          size="sm"
          title="No withdrawals yet"
          description="A request appears here as soon as it is submitted, before any operator has reviewed it."
        />
      }
    />
  );
}
