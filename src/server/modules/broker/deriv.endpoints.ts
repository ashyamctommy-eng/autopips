/**
 * Deriv endpoint constants — a LEAF module.
 *
 * It imports nothing, and that is the whole point: `src/lib/env.ts` needs these
 * values for its defaults and its retired-host guard, and `env.ts` is the lowest
 * layer of the server. Importing them from `deriv.client.ts` instead (which
 * pulls in `ws` and `@/lib/http`) created a cycle in which the constants were
 * still undefined while `env.ts` was being evaluated — the default then failed
 * `.url()` validation and the whole environment contract looked broken.
 *
 * Keep it dependency-free.
 */

/**
 * Deriv's CURRENT public market-data socket — no account, no token.
 *
 * Deriv moved its API. The legacy host (`ws.derivws.com`) now answers Cloudflare
 * 520 to EVERY request — every path, every app_id, from every network tested (a
 * cloud sandbox, a Railway container, and a real browser engine). That 520 is
 * what the production audit log recorded as:
 *
 *   "Could not reach Deriv: Unexpected server response: 520"
 *
 * It was never a credentials problem: the edge could not get a usable response
 * from the retired origin. The protocol did not change — `echo_req`/`msg_type`
 * request-response is intact — so message shapes carry over unchanged.
 */
export const DERIV_PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

/** REST base for the account/trading side (account list, OTP issuance). */
export const DERIV_REST_BASE_URL = 'https://api.derivws.com';

/**
 * Hosts that are RETIRED. Kept so the environment contract can refuse them with
 * an explanation, instead of surfacing a 520 three layers deep at trade time.
 */
export const DERIV_RETIRED_HOSTS = ['ws.derivws.com', 'ws.binaryws.com'] as const;

/** True when a configured URL points at a retired Deriv host. */
export function isRetiredDerivHost(url: string): boolean {
  try {
    const { host } = new URL(url);
    return DERIV_RETIRED_HOSTS.some((retired) => host === retired);
  } catch {
    return false;
  }
}
