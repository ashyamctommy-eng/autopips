import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { D, usd } from '@/lib/money';
import { getAccountSnapshot } from '@/server/accounting/ledger';
import { publishEquity } from '@/server/ws/event-bus';

export const adjustmentSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().finite().positive().max(1_000_000_000_000)
    .refine(value => D(value).decimalPlaces() <= 2, 'Use at most two decimal places.'),
  type: z.enum(['credit', 'debit']),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export async function readWalletBalance(userId: string) {
  if (!await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) {
    throw ApiError.notFound('User not found.');
  }
  const snapshot = await getAccountSnapshot(userId);
  return { userId, balance: snapshot.withdrawableBalance.toFixed(2) };
}

export async function adjustWalletBalance(actorId: string, raw: unknown, requestKey: string) {
  const input = adjustmentSchema.parse(raw);
  const key = z.string().uuid().parse(requestKey);
  const signedAmount = D(input.amount).times(input.type === 'credit' ? 1 : -1);
  const result = await prisma.$transaction(async tx => {
    // Same account lock as trades, investment allocation, and withdrawals.
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true } });
    if (actor?.role !== 'SUPER_ADMIN') throw ApiError.forbidden();
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!target) throw ApiError.notFound('User not found.');
    const existing = await tx.walletAdjustment.findUnique({ where: { idempotencyKey: key } });
    const before = await getAccountSnapshot(input.userId, tx);
    if (existing) {
      if (existing.actorId !== actorId || existing.userId !== input.userId ||
          !D(existing.amount).equals(signedAmount) || existing.description !== input.reason) {
        throw ApiError.conflict('This request key was already used for a different adjustment.');
      }
      return { userId: input.userId, balance: before.withdrawableBalance.toFixed(2), adjustmentId: existing.id };
    }
    if (input.type === 'debit' && D(before.withdrawableBalance).lessThan(input.amount)) {
      throw ApiError.conflict('Insufficient available balance. Invested funds and pending withdrawals cannot be debited.');
    }
    const row = await tx.walletAdjustment.create({
      data: { userId: input.userId, actorId, amount: usd(signedAmount), description: input.reason, idempotencyKey: key },
    });
    const after = await getAccountSnapshot(input.userId, tx);
    await tx.auditLog.create({
      data: { userId: actorId, action: 'ADMIN_ADJUSTMENT', details: {
        targetUserId: input.userId, adjustmentId: row.id, amount: signedAmount.toFixed(2),
        reason: input.reason, status: 'completed',
        balanceBefore: before.withdrawableBalance.toFixed(2), balanceAfter: after.withdrawableBalance.toFixed(2),
      } },
    });
    return { userId: input.userId, balance: after.withdrawableBalance.toFixed(2), adjustmentId: row.id };
  });
  await publishEquity(input.userId, { userId: input.userId, reason: 'ADMIN_ADJUSTMENT', balance: result.balance }, true);
  return result;
}