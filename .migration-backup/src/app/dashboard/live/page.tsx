/**
 * `/dashboard/live` — alias for the live trading screen.
 *
 * The client sidebar (`CLIENT_NAV` in src/components/layout/sidebar.tsx) links
 * to this path; the screen itself lives at `/dashboard/trading`. Rather than
 * duplicate the server component (and its data loading), this route re-exports
 * it. The shell and the services deliver exactly the same page either way.
 */
export { default } from '../trading/page';

export const dynamic = 'force-dynamic';
