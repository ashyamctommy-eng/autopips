import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { listSupportedCurrencies } from '@/server/modules/payments/payments.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/payments/currencies
 *
 * The settlement currencies a client may use for deposits/withdrawals, with
 * provider minimums. The server-side allow-list always wins: if NOWPayments is
 * unreachable the allow-listed currencies are still returned, flagged
 * `providerVerified: false` (and the client should not be quoted a rate).
 */
export const GET = handler(async () => {
  // Requires a session: this is client-facing configuration, not public info.
  await requireSessionUser();

  const supported = await listSupportedCurrencies();
  return ok(supported);
});
