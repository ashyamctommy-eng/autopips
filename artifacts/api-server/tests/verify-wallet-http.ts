// Explicit opt-in integration probe. Uses isolated fixture accounts only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/imported/lib/prisma';
import { hashPassword } from '../src/imported/server/modules/auth/password.service';

async function main() {
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const password = `Probe-${randomUUID()}!`;
  const passwordHash = await hashPassword(password);
  const ids: string[] = [];
  const sessions: string[] = [];
  try {
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'CLIENT'] as const) {
      const user = await prisma.user.create({ data: {
        email: `wallet-probe-${randomUUID()}@example.test`, fullName: 'Wallet verification',
        country: '', role, passwordHash,
      } });
      ids.push(user.id);
      const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ email: user.email, password }),
      });
      assert.equal(response.status, 200);
      sessions.push(response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '));
    }
    const key = randomUUID();
    const body = { userId: ids[2], amount: 100, type: 'credit', reason: 'Isolated automated wallet verification' };
    const adjust = async (cookie: string, payload: typeof body, requestKey = randomUUID()) => {
      const response = await fetch(`${base}/api/admin/wallets/adjust-balance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'Idempotency-Key': requestKey },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await adjust(sessions[1], body)).status, 403);
    assert.equal((await adjust(sessions[2], body)).status, 403);
    assert.equal((await adjust('', body)).status, 401);
    const credit = await adjust(sessions[0], body, key);
    assert.equal(credit.status, 200);
    assert.equal(credit.body.data.balance, '100.00');
    const replay = await adjust(sessions[0], body, key);
    assert.equal(replay.body.data.adjustmentId, credit.body.data.adjustmentId);
    assert.equal(replay.body.data.balance, '100.00');
    assert.equal((await adjust(sessions[0], { ...body, amount: 101 }, key)).status, 409);
    const attempts = await Promise.all([
      adjust(sessions[0], { ...body, type: 'debit', amount: 75 }),
      adjust(sessions[0], { ...body, type: 'debit', amount: 75 }),
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const wallet = await fetch(`${base}/api/admin/wallets/${ids[2]}`, { headers: { Cookie: sessions[0] } });
    assert.equal((await wallet.json()).data.balance, '25.00');
    assert.equal(await prisma.walletAdjustment.count({ where: { userId: ids[2] } }), 2);
    assert.equal(await prisma.auditLog.count({ where: { userId: ids[0], action: 'ADMIN_ADJUSTMENT' } }), 2);
    console.log('PASS: real HTTP role gates, credit, replay, conflicting replay, concurrent debit/overdraft, balance and audit consistency.');
  } finally {
    for (const cookie of sessions) {
      await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } }).catch(() => undefined);
    }
    await prisma.$transaction(async tx => {
      await tx.walletAdjustment.deleteMany({ where: { userId: { in: ids } } });
      await tx.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    await prisma.$disconnect();
  }
}
main().catch(() => { console.error('Wallet HTTP verification failed; no credentials logged.'); process.exitCode = 1; });