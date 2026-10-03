/**
 * `?next=` handling for the sign-in page.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/middleware.ts` forwards an unauthenticated visitor to
 * `/login?next=<pathname+search>` so they land where they were headed after
 * signing in. That value is attacker-controllable: a link to
 * `/login?next=https://evil.example` (or `//evil.example`) must never turn the
 * sign-in page into an open redirect that launders a phishing hop through
 * autopips.pro.
 *
 * The rule is therefore allow-list, not deny-list:
 *   1. the raw value must begin with exactly one `/`;
 *   2. it is resolved against a fixed, non-routable origin with the WHATWG URL
 *      parser, and anything that resolves to a different origin is rejected —
 *      this catches protocol-relative (`//host`), backslash (`/\host`, which
 *      browsers normalise to `//host`) and absolute-URL (`https://host`,
 *      `javascript:`, `data:`) forms in one check;
 *   3. only the resulting pathname + search + hash are kept, and anything
 *      pointing back at the auth pages is dropped to avoid a pointless bounce.
 *
 * A rejected value falls back to `/dashboard`, which is the same destination the
 * middleware uses for a signed-in visitor, so the failure mode is "you ended up
 * on your dashboard", never "you ended up on someone else's site".
 */

export const DEFAULT_POST_LOGIN_PATH = '/dashboard';

/** Resolving base for validation. `.invalid` is reserved and never routable. */
const VALIDATION_BASE = 'http://autopipsz.invalid';

/** Signing in and being sent back to the sign-in form is not a useful hop. */
const AUTH_PATHS = new Set(['/login', '/register']);

export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_PATH,
): string {
  if (typeof raw !== 'string') return fallback;

  // A single leading slash only: `//host` is protocol-relative, and any value
  // not starting with `/` is either absolute or relative-to-nowhere.
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;

  try {
    const resolved = new URL(raw, VALIDATION_BASE);
    if (resolved.origin !== VALIDATION_BASE) return fallback;

    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (!path.startsWith('/') || path.startsWith('//')) return fallback;
    if (AUTH_PATHS.has(resolved.pathname)) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

export const DEFAULT_POST_LOGIN_CONSOLE_PATH = '/admin';

/**
 * `?next=` handling for the CONSOLE sign-in page.
 *
 * Same allow-list as {@link safeNextPath}, with one extra rule: the destination
 * must be inside the console. A staff member who followed a link to
 * `/admin/login?next=/dashboard` should end up in the console, not in the client
 * workspace — and `/admin/login` itself is dropped, because signing in and being
 * returned to the sign-in page is a loop rather than a hop.
 */
export function safeConsolePath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_CONSOLE_PATH,
): string {
  const path = safeNextPath(raw, fallback);
  if (!path.startsWith('/admin')) return fallback;
  if (path === '/admin/login' || path.startsWith('/admin/login?') || path.startsWith('/admin/login#')) {
    return fallback;
  }
  return path;
}
