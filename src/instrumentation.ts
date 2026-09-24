/**
 * Next.js instrumentation hook — runs ONCE per web server process, before any
 * request is served.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `serverEnv()` validates `process.env` and throws a readable list of problems.
 * Its docstring promises it "fails fast and loudly at boot rather than at the
 * first trade" — but nothing in the web process called it at boot, so the parse
 * happened LAZILY, inside whichever request handler first needed it. The socket
 * worker has always validated first and exited; the web tier did not.
 *
 * That asymmetry caused a real outage: `DERIV_APP_ID` became a required variable
 * in the Deriv swap, the deployment was restarted without it, and the site came
 * up looking healthy — pages rendered, `/api/v1/health` reported ok, public
 * endpoints worked — while sign-in returned 500 for every correct password,
 * because the login success path is the first place that needed a variable only
 * the environment contract knows about. Nothing in the logs pointed at the
 * environment; the symptom was three layers away from the cause.
 *
 * So: validate here, once, before the server accepts traffic. A missing or
 * malformed variable now stops the process with the exact list, which is a
 * failed deploy with an actionable message instead of a silently half-working
 * production site.
 *
 * This is a synchronous throw on purpose — there is no useful degraded mode for
 * a platform that cannot sign anyone in.
 */
export async function register(): Promise<void> {
  // The edge runtime has no access to the server-only variables (and must not).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { serverEnv } = await import('@/lib/env');

  try {
    serverEnv();
  } catch (err) {
    console.error('[boot] FATAL: the server environment is invalid — refusing to start.');
    console.error(err instanceof Error ? err.message : err);
    // An explicit exit, not a rethrow: Next.js 14 logs a throwing hook and then
    // reports "Ready" anyway, leaving a container that looks healthy and serves
    // a half-working site. Exiting non-zero is what the socket worker already
    // does (src/server/main.ts) — the platform then fails the deploy, keeps the
    // previous version live, and shows the message above.
    process.exit(1);
  }
}
