import { z } from 'zod';
import { handler, ok } from '@/lib/http';
import { requireSuperAdmin } from '@/server/modules/auth/session';
import { readWalletBalance } from '@/server/modules/admin/wallet-adjustment.service';

export const GET = handler(async (request: Request) => {
  await requireSuperAdmin();
  const id = z.string().uuid().parse(new URL(request.url).pathname.split('/').pop());
  return ok(await readWalletBalance(id));
});