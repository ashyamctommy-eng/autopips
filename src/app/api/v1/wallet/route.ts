import { handler, ok } from '@/lib/http';
import { requireSessionUser } from '@/server/modules/auth/session';
import { getWallet } from '@/server/modules/positions/position.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/wallet
 *
 * The caller's wallet, DERIVED from the ledger — there is no `User.balance`
 * column. Every figure comes from the same `getAccountSnapshot` that backs the
 * dashboard, the withdrawal gate and the admin projection, so the wallet cannot
 * disagree with any of them.
 *
 * `availableUsd` is what can be spent now (equity − deployed capital − pending
 * withdrawals); `deployedUsd` is locked in strategies and open positions.
 */
export const GET = handler(async () => {
  const user = await requireSessionUser();
  const wallet = await getWallet(user.id);
  return ok({ wallet });
});
