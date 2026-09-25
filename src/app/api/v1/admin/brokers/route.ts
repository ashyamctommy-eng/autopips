import { z } from 'zod';
import { clientIp, handler, ok, readJson } from '@/lib/http';
import { requireAdmin, requireAdminOrManager } from '@/server/modules/auth/session';
import { getBrokerConnection, listBrokers } from '@/server/modules/admin/admin.service';
import { addBrokerConnection } from '@/server/modules/broker/broker.registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/v1/admin/brokers?probe=1  — every broker connection
 * POST /api/v1/admin/brokers          — register an account (ADMIN only)
 *
 * LATENCY HONESTY: `latencyMs` is only populated when `?probe=1` is sent,
 * because a real probe connects an adapter and performs an RPC round-trip per
 * account. Without the flag every row reports `latencyMs: null` — "not probed",
 * never a fabricated number. Use GET /api/v1/admin/brokers/:id/status to probe a
 * single connection.
 *
 * TOKEN HANDLING: the POST body carries the account's Deriv API token in plain
 * text over TLS. It is validated as a non-empty string, handed straight to
 * `addBrokerConnection` (which encrypts it with AES-256-GCM before it is stored)
 * and never logged, never echoed in the response and never written to the audit
 * trail.
 */

const createBrokerSchema = z
  .object({
    derivAccountId: z.string().trim().min(1, 'A MetaApi account id is required.').max(128),
    brokerName: z.string().trim().min(1, 'A broker name is required.').max(64),
    environment: z.enum(['LIVE', 'DEMO']),
    token: z
      .string()
      .min(1, 'A Deriv API token is required.')
      .max(4_096, 'That Deriv API token looks too long.')
      .refine((value) => value.trim().length > 0, 'A Deriv API token is required.'),
  })
  .strict();

export const GET = handler(async (request: Request) => {
  await requireAdminOrManager();

  const { searchParams } = new URL(request.url);
  const probe = searchParams.get('probe');
  const probeLatency = probe === '1' || probe === 'true';

  return ok(await listBrokers({ probeLatency }));
});

export const POST = handler(async (request: Request) => {
  const session = await requireAdmin();

  const body = createBrokerSchema.parse(await readJson(request));

  // The connection is only persisted after a successful live account probe
  // (see addBrokerConnection) — a placeholder balance/mask never reaches the UI.
  const created = await addBrokerConnection({
    derivAccountId: body.derivAccountId,
    brokerName: body.brokerName,
    environment: body.environment,
    token: body.token,
    adminUserId: session.userId,
    ip: clientIp(request),
  });

  // Re-read through the DTO mapper so the response can never carry the token.
  return ok(await getBrokerConnection(created.id), { status: 201 });
});
