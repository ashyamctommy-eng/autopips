import { useMemo, useSyncExternalStore } from 'react';
import { useLocation, useSearch } from 'wouter';
import { navigate } from 'wouter/use-browser-location';

/** Thrown by redirect(); the route runtime turns it into a navigation. */
export class RedirectSignal extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`REDIRECT:${url}`);
    this.name = 'RedirectSignal';
    this.url = url;
  }
}

/** Thrown by notFound(); the route runtime renders the not-found page. */
export class NotFoundSignal extends Error {
  constructor() {
    super('NOT_FOUND');
    this.name = 'NotFoundSignal';
  }
}

export function redirect(url: string): never {
  throw new RedirectSignal(url);
}
export const permanentRedirect = redirect;

export function notFound(): never {
  throw new NotFoundSignal();
}

/* router.refresh(): re-runs the data-fetching wrappers of the current route. */
let refreshTick = 0;
const listeners = new Set<() => void>();
export function useRefreshTick(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => refreshTick,
    () => 0,
  );
}
function refresh() {
  refreshTick += 1;
  listeners.forEach((cb) => cb());
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => {
        navigate(href);
        window.scrollTo(0, 0);
      },
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh,
      prefetch: (_href: string) => {},
    }),
    [],
  );
}

export function usePathname(): string {
  return useLocation()[0];
}

export function useSearchParams(): URLSearchParams {
  const search = useSearch();
  return useMemo(() => new URLSearchParams(search), [search]);
}
