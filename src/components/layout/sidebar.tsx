'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CandlestickChart,
  History,
  LayoutDashboard,
  LineChart,
  PanelLeft,
  Settings,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/shared/brand-mark';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { useControllableBoolean } from '@/hooks/use-controllable-state';
import type { KycStatusValue } from '@/types/api';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Match the path exactly (use for the dashboard root). */
  exact?: boolean;
  /** Right-aligned counter — pass a `<Badge />`. */
  badge?: React.ReactNode;
  /** Hide the item entirely. */
  hidden?: boolean;
}

/** Client dashboard navigation. Exported so pages can render it elsewhere. */
export const CLIENT_NAV: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard, exact: true },
  { label: 'Markets', href: '/dashboard/markets', icon: LineChart },
  // The canonical path. `/dashboard/live` remains a working alias, but linking to
  // the alias meant a deep link (e.g. from the markets list, `?symbol=`) left this
  // item unhighlighted — the nav said "nowhere" on a page it owns.
  { label: 'Live Trading', href: '/dashboard/trading', icon: CandlestickChart },
  { label: 'Positions', href: '/dashboard/positions', icon: Activity },
  { label: 'History', href: '/dashboard/history', icon: History },
  { label: 'Wallet', href: '/dashboard/wallet', icon: Wallet },
  { label: 'KYC', href: '/dashboard/kyc', icon: ShieldCheck },
  { label: 'Deposits', href: '/dashboard/deposits', icon: ArrowDownToLine },
  { label: 'Withdrawals', href: '/dashboard/withdrawals', icon: ArrowUpFromLine },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export interface SidebarShellProps extends React.HTMLAttributes<HTMLElement> {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  ariaLabel: string;
  onToggleCollapse?: () => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Presentational sidebar frame shared by {@link ClientSidebar} and
 * {@link AdminSidebar}: brand row, collapse toggle, nav list, pinned footer.
 */
export function SidebarShell({
  items,
  pathname,
  collapsed,
  ariaLabel,
  onToggleCollapse,
  header,
  footer,
  className,
  ...props
}: SidebarShellProps) {
  const visible = items.filter((item) => !item.hidden);
  return (
    <aside
      aria-label={ariaLabel}
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-line bg-base-900/95 backdrop-blur transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-64',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-line',
          collapsed ? 'justify-center px-2' : 'justify-between px-3',
        )}
      >
        {header}
        {onToggleCollapse && !collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            aria-label="Collapse navigation"
            className="size-8 shrink-0 text-muted"
          >
            <PanelLeft />
          </Button>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
        <ul className="flex flex-col gap-0.5">
          {visible.map((item) => {
            const active = isNavItemActive(pathname, item);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg py-2 text-sm transition-colors',
                    collapsed ? 'justify-center px-2' : 'px-2.5',
                    active
                      // Token, not a literal: the active rail has to follow the
                      // light palette too (a hardcoded #22D3EE stayed cyan on white).
                      ? 'bg-brand/10 text-base-100 shadow-[inset_2px_0_0_0_rgb(var(--c-brand-400))]'
                      : 'text-muted hover:bg-base-800 hover:text-base-100',
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn('size-4 shrink-0', active ? 'text-brand-400' : 'text-muted')}
                  />
                  {collapsed ? (
                    <span className="sr-only">{item.label}</span>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge}
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {onToggleCollapse && collapsed ? (
        <div className="flex justify-center border-t border-line p-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            aria-label="Expand navigation"
            className="size-8 text-muted"
          >
            <PanelLeft className="rotate-180" />
          </Button>
        </div>
      ) : null}

      {footer ? <div className="shrink-0 border-t border-line p-3">{footer}</div> : null}
    </aside>
  );
}

export interface SidebarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** Controlled collapse state. Omit to let the sidebar own it. */
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Hide the collapse toggle (e.g. inside the mobile drawer). */
  showCollapseToggle?: boolean;
  /** Drives the KYC prompt in the footer; the badge shows unless APPROVED. */
  kycStatus?: KycStatusValue;
  /** Override the nav (defaults to {@link CLIENT_NAV}). */
  items?: NavItem[];
}

/**
 * Client dashboard navigation. Highlights the active route from the pathname
 * and nudges the user toward KYC until their identity is approved.
 */
export function ClientSidebar({
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  showCollapseToggle = true,
  kycStatus,
  items = CLIENT_NAV,
  className,
  ...props
}: SidebarProps) {
  const pathname = usePathname() ?? '';
  const [isCollapsed, toggleCollapse] = useControllableBoolean({
    value: collapsed,
    defaultValue: defaultCollapsed,
    onChange: onCollapsedChange,
  });

  const kycPending = kycStatus !== undefined && kycStatus !== 'APPROVED';

  return (
    <SidebarShell
      ariaLabel="Client navigation"
      items={items}
      pathname={pathname}
      collapsed={isCollapsed}
      onToggleCollapse={showCollapseToggle ? toggleCollapse : undefined}
      className={className}
      header={<BrandMark size="md" showWordmark={!isCollapsed} />}
      footer={
        kycPending && kycStatus !== undefined ? (
          isCollapsed ? (
            <Link
              href="/dashboard/kyc"
              title={`KYC: ${kycStatus}`}
              className="flex justify-center"
              aria-label={`KYC status: ${kycStatus}`}
            >
              <span className="size-2 rounded-full bg-warn animate-pulse-ring" />
            </Link>
          ) : (
            <Link
              href="/dashboard/kyc"
              className="flex flex-col gap-2 rounded-lg border border-warn/25 bg-warn/[0.06] p-2.5 transition-colors hover:border-warn/40"
            >
              <span className="text-xs font-medium text-base-100">Identity check</span>
              <StatusBadge status={kycStatus} kind="kyc" showIcon />
            </Link>
          )
        ) : null
      }
      {...props}
    />
  );
}

export default ClientSidebar;
