import { handler, ok, readJson } from '@/lib/http';
import { requireSuperAdmin } from '@/server/modules/auth/session';
import { adjustWalletBalance } from '@/server/modules/admin/wallet-adjustment.service';

export const POST = handler(async (request: Request) => {
  const actor = await requireSuperAdmin();
  return ok(await adjustWalletBalance(actor.userId, await readJson(request), request.headers.get('Idempotency-Key') ?? ''));
});