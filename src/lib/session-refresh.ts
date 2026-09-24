'use client';

import * as React from 'react';

/**
 * Session keep-alive and one-shot recovery for authenticated API calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * The access token lives 15 minutes (`ACCESS_TOKEN_TTL`). The refresh cookie
 * lives 30 days. Nothing in the browser ever called `POST /api/v1/auth/refresh`,
 * so the two were never connected: a page loaded at 09:00 kept rendering, but
 * every request it made after 09:15 came back 401 — surfaced verbatim as
 * "Authentication required." in whichever form the operator happened to submit.
 * Registering a broker connection was where it was noticed; it applied to the
 * whole console and to every client action.
 *
 * TWO HALVES, ON PURPOSE
 * ----------------------
 *   • `useSessionKeepAlive()` refreshes on a timer while a page is open, so the
 *     session does not lapse in the first place (mounted once, in `AppShell`).
 *   • `apiFetch()`/`withSessionRetry()` recover the 401 that happens anyway —
 *     a laptop that slept through the expiry, a clock skew, a first request
 *     after the tab was backgrounded.
 *
 * THE REFRESH IS ROTATING AND SINGLE-USE, so this module refuses to fire two
 * refreshes at once: `refreshSession()` shares one in-flight promise. A second
 * presentation of the same token is treated by the server as a REPLAY and
 * revokes the whole session family — a retry storm here would log the operator
 * out rather than back in. For the same reason a failed refresh is never
 * retried automatically, and nothing here runs on a hidden tab.
 */

let inFlight: Promise<boolean> | null = null;

/**
 * Ask the server to rotate the session. Returns false when there is nothing to
 * rotate (no cookie, expired, replayed, server unreachable) — callers then treat
 * the original 401 as final.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * `fetch` for AUTHENTICATED calls, with a single refresh-and-retry on 401.
 *
 * Do not use this for sign-in: a 401 there means "wrong password", not "stale
 * session", and refreshing would be pointless. The auth forms keep their own
 * helpers.
 *
 * The request is re-issued only when it is safe to send the identical request
 * twice: a string body (all of ours are JSON strings) or no body. A streaming
 * body is returned as-is, because it cannot be replayed.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 401) return response;
  if (init.body !== undefined && typeof init.body !== 'string') return response;

  const refreshed = await refreshSession();
  if (!refreshed) return response;

  return fetch(input, init);
}

/**
 * Retry a request that has ALREADY been sent and answered, when the answer was
 * a 401 and a refresh succeeds. Used by the admin API client, which wants to
 * inspect the response before deciding.
 */
export async function retryAfterRefresh(
  response: Response,
  replay: () => Promise<Response>,
): Promise<Response> {
  if (response.status !== 401) return response;
  if (!(await refreshSession())) return response;
  return replay();
}

/**
 * Keep the session alive while a page is open.
 *
 * Ten minutes against a fifteen-minute token: far enough ahead that a slow
 * network still lands inside the window, and far enough apart that two ticks
 * cannot collide. Skipped while the tab is hidden — a background refresh is the
 * one that races another tab's, and there is nothing to keep alive if nobody is
 * looking.
 */
export function useSessionKeepAlive(intervalMs = 10 * 60 * 1000): void {
  React.useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshSession();
      }
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
