'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';

export interface DataTableColumn<T> {
  /** Stable identity for the column (also used as the React key). */
  key: string;
  header: React.ReactNode;
  cell: (row: T, rowIndex: number) => React.ReactNode;
  className?: string;
  headerClassName?: string;
  align?: 'left' | 'center' | 'right';
  /** Fixed width, e.g. `w-32`. */
  width?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable key per row — never fall back to the array index for live data. */
  getRowKey: (row: T, rowIndex: number) => string;
  /** Rendered when `rows` is empty and `isLoading` is false. */
  emptyState?: React.ReactNode;
  isLoading?: boolean;
  /** Skeleton row count while loading. Defaults to 5. */
  skeletonRows?: number;
  /** Row click handler — also makes rows keyboard-activatable. */
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  caption?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  /** Hide the header entirely (e.g. inside a compact drawer). */
  hideHeader?: boolean;
}

const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * Generic, client-side data table.
 *
 * It renders exactly the rows it is given: an empty array produces
 * {@link EmptyState}, never placeholder rows. Used by positions, trades, the
 * KYC queue, users, logs, deposits and withdrawals.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyState,
  isLoading = false,
  skeletonRows = 5,
  onRowClick,
  rowClassName,
  caption,
  className,
  containerClassName,
  hideHeader = false,
}: DataTableProps<T>) {
  const showEmpty = !isLoading && rows.length === 0;
  const interactive = typeof onRowClick === 'function';

  return (
    // `.surface` is the shared glass panel (see globals.css) — the same one
    // `Card` renders — with `overflow-hidden` kept for the rounded corners.
    // Scrolling stays on the inner `Table` container, so a wide table scrolls
    // inside this panel instead of pushing the page wider than the viewport.
    <div className={cn('surface w-full overflow-hidden', className)}>
      {showEmpty ? (
        <div className="p-2">
          {emptyState ?? <EmptyState title="Nothing to show yet" />}
        </div>
      ) : (
        <Table containerClassName={containerClassName}>
          {caption ? <TableCaption>{caption}</TableCaption> : null}
          {!hideHeader && (
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column) => (
                  <TableHead
                    key={column.key}
                    className={cn(
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.width,
                      column.headerClassName,
                    )}
                  >
                    {column.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
          )}
          <TableBody>
            {isLoading
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                    {columns.map((column) => (
                      <TableCell key={column.key} className={column.className}>
                        <Skeleton className="h-4 w-full max-w-[10rem]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row, rowIndex) => (
                  <TableRow
                    key={getRowKey(row, rowIndex)}
                    onClick={interactive ? () => onRowClick?.(row) : undefined}
                    onKeyDown={
                      interactive
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onRowClick?.(row);
                            }
                          }
                        : undefined
                    }
                    role={interactive ? 'button' : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    className={cn(
                      interactive && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(ALIGN_CLASS[column.align ?? 'left'], column.className)}
                      >
                        {column.cell(row, rowIndex)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
