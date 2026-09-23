'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, LogOut, Menu, Settings, User as UserIcon } from 'lucide-react';

import { cn, relativeTime } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';

export interface TopbarNotification {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** ISO timestamp — rendered as a relative time. */
  createdAt: string;
  /** Optional deep link to the surface that produced the notification. */
  href?: string;
  read?: boolean;
}

export interface TopbarUser {
  name: string;
  email?: string;
  avatarUrl?: string | null;
}

export interface TopbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Live bot/broker status widget slot — typically
   * `<LiveDot state={…} label="Bot status" />`.
   */
  botStatus?: React.ReactNode;
  notifications?: TopbarNotification[];
  user?: TopbarUser;
  /** Called when "Sign out" is chosen (wire to your auth route). */
  onSignOut?: () => void;
  /** Render sign out as a link instead of a button. */
  signOutHref?: string;
  /** Breadcrumb / page title area (usually `<PageHeader />` lives below). */
  breadcrumb?: React.ReactNode;
  /** Mobile drawer trigger; hidden on `lg` and up. */
  onToggleSidebar?: () => void;
  /** Right-hand slot after the user menu. */
  actions?: React.ReactNode;
  /** Rows shown inside the notifications dropdown. Defaults to 5. */
  notificationLimit?: number;
}

/**
 * Sticky top bar: mobile nav trigger, bot-status slot, notifications and the
 * user menu. Page-agnostic — it deliberately knows nothing about routing.
 */
export function Topbar({
  botStatus,
  notifications,
  user,
  onSignOut,
  signOutHref,
  breadcrumb,
  onToggleSidebar,
  actions,
  notificationLimit = 5,
  className,
  ...props
}: TopbarProps) {
  const list = notifications ?? [];
  const unread = list.filter((notification) => !notification.read).length;
  const visible = list.slice(0, notificationLimit);
  const initials = initialsOf(user?.name);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-base-900/80 px-4 backdrop-blur',
        className,
      )}
      {...props}
    >
      {onToggleSidebar ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          aria-label="Open navigation"
          className="size-8 lg:hidden"
        >
          <Menu />
        </Button>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {botStatus}
        {breadcrumb ? <div className="min-w-0 truncate text-sm text-muted">{breadcrumb}</div> : null}
      </div>

      {actions}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative size-9 text-muted"
            aria-label={
              unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
            }
          >
            <Bell />
            {unread > 0 ? (
              <Badge
                variant="danger"
                className="absolute -right-0.5 -top-0.5 min-w-4 justify-center px-1 py-0 text-[0.6rem]"
              >
                {unread > 9 ? '9+' : unread}
              </Badge>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {visible.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Bell}
              title="Nothing new"
              description="Trade fills, KYC decisions and settlement updates appear here."
            />
          ) : (
            visible.map((notification) => (
              <DropdownMenuItem key={notification.id} asChild={Boolean(notification.href)}>
                {notification.href ? (
                  <Link href={notification.href} className="flex flex-col items-start gap-0.5">
                    <NotificationBody notification={notification} />
                  </Link>
                ) : (
                  <span className="flex w-full flex-col items-start gap-0.5">
                    <NotificationBody notification={notification} />
                  </span>
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-base-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            aria-label="Account menu"
          >
            <Avatar size="sm">
              {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
              <AvatarFallback>{initials || <UserIcon className="size-3.5" />}</AvatarFallback>
            </Avatar>
            {user?.name ? (
              <span className="hidden max-w-[10rem] truncate text-sm text-base-100 sm:inline">
                {user.name}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {user?.name ? (
            <>
              <DropdownMenuLabel className="normal-case tracking-normal">
                <span className="block truncate text-sm text-base-100">{user.name}</span>
                {user.email ? (
                  <span className="block truncate text-xs text-muted">{user.email}</span>
                ) : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <UserIcon />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {signOutHref ? (
            <DropdownMenuItem destructive asChild>
              <Link href={signOutHref}>
                <LogOut />
                Sign out
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem destructive onSelect={() => onSignOut?.()} disabled={!onSignOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function NotificationBody({ notification }: { notification: TopbarNotification }) {
  return (
    <>
      <span className="flex w-full items-center gap-2">
        {!notification.read ? <span className="size-1.5 shrink-0 rounded-full bg-brand" /> : null}
        <span className="min-w-0 flex-1 truncate text-sm text-base-100">{notification.title}</span>
      </span>
      {notification.description ? (
        <span className="line-clamp-2 text-xs leading-relaxed text-muted">
          {notification.description}
        </span>
      ) : null}
      <time
        dateTime={notification.createdAt}
        suppressHydrationWarning
        className="text-[0.65rem] tabular-nums text-muted"
      >
        {relativeTime(notification.createdAt)}
      </time>
    </>
  );
}
