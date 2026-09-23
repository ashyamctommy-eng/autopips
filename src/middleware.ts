import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware — coarse-grained route protection only.
 *
 * It checks for the PRESENCE of the access cookie, never its validity: JWT
 * verification needs the server-only signing key, which must not be available
 * at the edge, and `jose` verification here would still not be authoritative.
 * Every API route and every server component re-verifies properly via
 * `requireSession()`. This is a UX redirect layer, not a security boundary.
 *
 * Tokens are read from cookies only. Nothing is read from localStorage or a
 * query string.
 */

const ACCESS_COOKIE = 'ap_at';

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);

  const isDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  const isAuthPage = pathname === '/login' || pathname === '/register';

  // Unauthenticated visitors hitting a private area → sign in, preserving where
  // they were headed. Admin has its own entry point.
  if (!hasSessionCookie && (isDashboard || isAdmin)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // Already signed in → don't show the login form again.
  if (hasSessionCookie && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  // Defence-in-depth headers for HTML routes (next.config.mjs covers all paths).
  if (!pathname.startsWith('/api/')) {
    response.headers.set('X-Robots-Tag', isDashboard || isAdmin ? 'noindex, nofollow' : 'all');
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Run on pages only. Exclude API routes (they do their own auth), Next
     * internals, the socket proxy path and static assets.
     */
    '/((?!api|_next/static|_next/image|ws|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
