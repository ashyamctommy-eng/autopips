'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import {
  Gauge,
  Plug,
  ScrollText,
  ShieldCheck,
  Users,
  ArrowUpFromLine,
  Layers,
  Settings,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/shared/brand-mark';
import { Badge } from '@/components/ui/badge';
import { useControllableBoolean } from '@/hooks/use-controllable-state';
import { SidebarShell, type NavItem } from '@/components/layout/sidebar';

/** Admin suite navigation. Exported so admin pages can reuse the labels. */
export const ADMIN_NAV: NavItem[] = [
  { label: 'AUM Dashboard', href: '/admin', icon: Gauge, exact: true },
  { label: 'KYC Review', href: '/admin/kyc', icon: ShieldCheck },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'Plans', href: '/admin/plans', icon: Layers },
  { label: 'Broker Connections', href: '/admin/brokers', icon: Plug },
  { label: 'Withdrawals', href: '/admin/withdrawals', icon: ArrowUpFromLine },
  { label: 'Audit Logs', href: '/admin/audit', icon: ScrollText },
  { label: 'Platform Settings', href: '/admin/settings', icon: Settings },
];

export interface AdminSidebarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** Controlled collapse state. Omit to let the sidebar own it. */
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Hide the collapse toggle (e.g. inside the mobile drawer). */
  showCollapseToggle?: boolean;
  /** Override the nav (defaults to {@link ADMIN_NAV}). */
  items?: NavItem[];
  /** Pending KYC count for the queue badge. Omit to hide the badge. */
  pendingKycCount?: number;
  /** Pending withdrawal count for the payouts badge. */
  pendingWithdrawalCount?: number;
}

/**
 * Admin suite navigation. Counts are passed in from the admin API — the shell
 * never fabricates a queue length.
 */
export function AdminSidebar({
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  showCollapseToggle = true,
  items = ADMIN_NAV,
  pendingKycCount,
  pendingWithdrawalCount,
  className,
  ...props
}: AdminSidebarProps) {
  const pathname = usePathname() ?? '';
  const [isCollapsed, toggleCollapse] = useControllableBoolean({
    value: collapsed,
    defaultValue: defaultCollapsed,
    onChange: onCollapsedChange,
  });

  const nav = React.useMemo(
    () =>
      items.map((item) => {
        if (item.href === '/admin/kyc' && typeof pendingKycCount === 'number' && pendingKycCount > 0) {
          return { ...item, badge: <Badge variant="warn">{pendingKycCount}</Badge> };
        }
        if (
          item.href === '/admin/withdrawals' &&
          typeof pendingWithdrawalCount === 'number' &&
          pendingWithdrawalCount > 0
        ) {
          return { ...item, badge: <Badge variant="warn">{pendingWithdrawalCount}</Badge> };
        }
        return item;
      }),
    [items, pendingKycCount, pendingWithdrawalCount],
  );

  return (
    <SidebarShell
      ariaLabel="Admin navigation"
      items={nav}
      pathname={pathname}
      collapsed={isCollapsed}
      onToggleCollapse={showCollapseToggle ? toggleCollapse : undefined}
      className={cn('bg-base-950/95', className)}
      header={
        isCollapsed ? (
          <BrandMark size="md" showWordmark={false} />
        ) : (
          <span className="flex items-center gap-2">
            <BrandMark size="md" showWordmark={false} />
            <Badge variant="brand" className="uppercase">
              Admin
            </Badge>
          </span>
        )
      }
      {...props}
    />
  );
}

export default AdminSidebar;
