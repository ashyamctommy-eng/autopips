import * as React from 'react';
import { useLocation } from 'wouter';
import { navigate } from 'wouter/use-browser-location';
import { NotFoundSignal, RedirectSignal, useRefreshTick } from './navigation';
import { RpcError } from '@/lib/rpc';
import NotFound from '@/app/not-found';

/**
 * Client replacement for Next server components.
 *
 * An original async page/layout is awaited OUTSIDE render and the element it
 * resolves to is rendered verbatim, so markup is unchanged. redirect() and
 * notFound() keep their meaning; loading.tsx is the fallback while pending and
 * error.tsx renders on failure.
 */

export type ErrorComponent = React.ComponentType<{ error: Error & { digest?: string }; reset: () => void }>;

const ChildrenContext = React.createContext<React.ReactNode>(null);
export function Slot() {
  return <>{React.useContext(ChildrenContext)}</>;
}

type AnyFn = (props: any) => any;

export async function renderServer(fn: AnyFn, props: Record<string, unknown>): Promise<React.ReactNode> {
  if (fn.constructor?.name === 'AsyncFunction') return await fn(props);
  return React.createElement(fn as React.ComponentType<any>, props);
}

function loginRedirect(target: string): string {
  const path = window.location.pathname;
  const here = `${path}${window.location.search}`;
  if (target === '/login' && path.startsWith('/admin') && path !== '/admin/login') {
    return `/admin/login?next=${encodeURIComponent(here)}`;
  }
  if (target === '/login' && path.startsWith('/dashboard')) {
    return `/login?next=${encodeURIComponent(here)}`;
  }
  return target;
}

class Boundary extends React.Component<
  { fallback: ErrorComponent; resetKey: string; onReset: () => void; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    const Fallback = this.props.fallback;
    if (this.state.error) {
      return (
        <Fallback
          error={this.state.error}
          reset={() => {
            this.setState({ error: null });
            this.props.onReset();
          }}
        />
      );
    }
    return this.props.children;
  }
}

interface RunnerProps {
  runKey: string;
  run: () => Promise<React.ReactNode>;
  fallback: React.ReactNode;
  error: ErrorComponent;
  /** Wrap the resolved node (layouts provide their children here). */
  children?: React.ReactNode;
  onResolved?: () => void;
}

type State =
  | { key: string; status: 'ready'; node: React.ReactNode }
  | { key: string; status: 'notfound' }
  | { key: string; status: 'error'; error: Error };

export function ServerRunner({ runKey, run, fallback, error: ErrorView, children, onResolved }: RunnerProps) {
  const tick = useRefreshTick();
  const [retry, setRetry] = React.useState(0);
  const [state, setState] = React.useState<State | null>(null);
  const runRef = React.useRef(run);
  runRef.current = run;
  const resolvedRef = React.useRef(onResolved);
  resolvedRef.current = onResolved;
  const [, setLocation] = useLocation();
  void setLocation;

  React.useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => runRef.current())
      .then((node) => {
        if (cancelled) return;
        setState({ key: runKey, status: 'ready', node });
        resolvedRef.current?.();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof RedirectSignal) {
          navigate(loginRedirect(err.url), { replace: true });
          return;
        }
        if (err instanceof NotFoundSignal) {
          setState({ key: runKey, status: 'notfound' });
          return;
        }
        if (err instanceof RpcError && (err.code === 'UNAUTHORIZED' || err.code === 'UNAUTHENTICATED')) {
          navigate(loginRedirect('/login'), { replace: true });
          return;
        }
        setState({ key: runKey, status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    return () => {
      cancelled = true;
    };
  }, [runKey, tick, retry]);

  if (!state || (state.key !== runKey && state.status !== 'ready')) return <>{fallback}</>;
  if (state.key !== runKey) return <>{fallback}</>;
  if (state.status === 'notfound') return <NotFound />;
  if (state.status === 'error') {
    return <ErrorView error={state.error} reset={() => setRetry((n) => n + 1)} />;
  }
  return (
    <Boundary fallback={ErrorView} resetKey={runKey} onReset={() => setRetry((n) => n + 1)}>
      <ChildrenContext.Provider value={children}>{state.node}</ChildrenContext.Provider>
    </Boundary>
  );
}
