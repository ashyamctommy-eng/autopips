import * as React from 'react';
import { useLocation, useSearch } from 'wouter';
import { applyMetadata } from '@/lib/next/head';
import { ServerRunner, Slot, renderServer, type ErrorComponent } from '@/lib/next/server-runtime';
import { getSessionUser } from '@/lib/services/session';
import { redirect } from '@/lib/next/navigation';
import type { Metadata } from '@/lib/next/types';
import NotFound from '@/app/not-found';
import RootError from '@/app/error';
import AuthError from '@/app/(auth)/error';
import PublicLoading from '@/app/(public)/loading';
import AuthLoading from '@/app/(auth)/loading';
import AdminLoading from '@/app/admin/loading';
import DashboardLoading from '@/app/dashboard/loading';

type Loader = () => Promise<{ default: any; metadata?: Metadata }>;

interface Group {
  layout: Loader;
  loading: React.ReactNode;
  error: ErrorComponent;
  guard?: () => Promise<void>;
  pages: Record<string, Loader>;
}

const signedInAwayFromAuth = async () => {
  /* Edge middleware used to bounce a signed-in visitor off /login and /register. */
  const user = await getSessionUser();
  if (user) redirect('/dashboard');
};

const GROUPS: Record<string, Group> = {
  public: {
    layout: () => import('@/app/(public)/layout'),
    loading: <PublicLoading />,
    error: RootError,
    pages: {
      '/': () => import('@/app/(public)/page'),
      '/about': () => import('@/app/(public)/about/page'),
      '/contact': () => import('@/app/(public)/contact/page'),
      '/faq': () => import('@/app/(public)/faq/page'),
      '/plans': () => import('@/app/(public)/plans/page'),
      '/privacy': () => import('@/app/(public)/privacy/page'),
      '/risk': () => import('@/app/(public)/risk/page'),
      '/strategies': () => import('@/app/(public)/strategies/page'),
      '/terms': () => import('@/app/(public)/terms/page'),
    },
  },
  auth: {
    layout: () => import('@/app/(auth)/layout'),
    loading: <AuthLoading />,
    error: AuthError,
    guard: signedInAwayFromAuth,
    pages: {
      '/login': () => import('@/app/(auth)/login/page'),
      '/register': () => import('@/app/(auth)/register/page'),
    },
  },
  adminAuth: {
    layout: () => import('@/app/(admin-auth)/layout'),
    loading: <AuthLoading />,
    error: RootError,
    pages: { '/admin/login': () => import('@/app/(admin-auth)/admin/login/page') },
  },
  admin: {
    layout: () => import('@/app/admin/layout'),
    loading: <AdminLoading />,
    error: RootError,
    pages: {
      '/admin': () => import('@/app/admin/page'),
      '/admin/audit': () => import('@/app/admin/audit/page'),
      '/admin/bot-control': () => import('@/app/admin/bot-control/page'),
      '/admin/brokers': () => import('@/app/admin/brokers/page'),
      '/admin/deposits': () => import('@/app/admin/deposits/page'),
      '/admin/kyc': () => import('@/app/admin/kyc/page'),
      '/admin/logout': () => import('@/app/admin/logout/page'),
      '/admin/logs': () => import('@/app/admin/logs/page'),
      '/admin/plans': () => import('@/app/admin/plans/page'),
      '/admin/settings': () => import('@/app/admin/settings/page'),
      '/admin/users': () => import('@/app/admin/users/page'),
      '/admin/withdrawals': () => import('@/app/admin/withdrawals/page'),
    },
  },
  dashboard: {
    layout: () => import('@/app/dashboard/layout'),
    loading: <DashboardLoading />,
    error: RootError,
    pages: {
      '/dashboard': () => import('@/app/dashboard/page'),
      '/dashboard/deposits': () => import('@/app/dashboard/deposits/page'),
      '/dashboard/history': () => import('@/app/dashboard/history/page'),
      '/dashboard/kyc': () => import('@/app/dashboard/kyc/page'),
      '/dashboard/live': () => import('@/app/dashboard/live/page'),
      '/dashboard/markets': () => import('@/app/dashboard/markets/page'),
      '/dashboard/messages': () => import('@/app/dashboard/messages/page'),
      '/dashboard/positions': () => import('@/app/dashboard/positions/page'),
      '/dashboard/settings': () => import('@/app/dashboard/settings/page'),
      '/dashboard/trading': () => import('@/app/dashboard/trading/page'),
      '/dashboard/wallet': () => import('@/app/dashboard/wallet/page'),
      '/dashboard/withdrawals': () => import('@/app/dashboard/withdrawals/page'),
    },
  },
};

function findRoute(path: string): { name: string; group: Group; loader: Loader } | null {
  for (const [name, group] of Object.entries(GROUPS)) {
    const loader = group.pages[path] as Loader | undefined;
    if (loader) return { name, group, loader };
  }
  return null;
}

function toSearchParams(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  new URLSearchParams(search).forEach((value, key) => {
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  });
  return out;
}

function GroupView({ name, group, loader }: { name: string; group: Group; loader: Loader }) {
  const [path] = useLocation();
  const search = useSearch();
  const layoutMeta = React.useRef<Metadata | undefined>(undefined);

  const page = (
    <ServerRunner
      runKey={`${name}:${path}?${search}`}
      fallback={group.loading}
      error={group.error}
      run={async () => {
        await group.guard?.();
        const mod = await loader();
        applyMetadata(mod.metadata, layoutMeta.current);
        return renderServer(mod.default, { params: {}, searchParams: toSearchParams(search) });
      }}
    />
  );

  return (
    <ServerRunner
      runKey={`layout:${name}`}
      fallback={group.loading}
      error={group.error}
      run={async () => {
        const mod = await group.layout();
        layoutMeta.current = mod.metadata;
        return renderServer(mod.default, { children: <Slot /> });
      }}
    >
      {page}
    </ServerRunner>
  );
}

export function AppRoutes() {
  const [raw] = useLocation();
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;

  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  const route = findRoute(path);
  React.useEffect(() => {
    if (!route) applyMetadata({ title: 'Not found' });
  }, [route]);
  if (!route) return <NotFound />;
  return <GroupView name={route.name} group={route.group} loader={route.loader} />;
}
