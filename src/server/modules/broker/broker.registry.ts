/**
 * Broker connection registry.
 *
 * Responsibilities:
 *  - turn a `BrokerConnection` row into a live `BrokerAdapter` (one adapter per
 *    MetaApi account id, cached in-process);
 *  - own the admin mutations (`addBrokerConnection`, `updateBrokerSnapshot`,
 *    `removeBrokerConnection`) and the audit trail for them;
 *  - expose the single activity/event-bus wiring used by the broker + bot runtime.
 *
 * ===================== WHERE THE METAAPI TOKEN LIVES =====================
 * The Prisma schema deliberately has no token column on `BrokerConnection`, so the
 * per-account MetaApi token is stored AES-256-GCM encrypted (`encryptCredential`,
 * purpose `metaapi`) under the Redis key
 *   `autopips:broker-token:<metaApiAccountId>`
 * Redis is not durable storage for a credential: keys can be evicted and a Redis
 * dump is a wider blast radius than a single DB column.
 *
 * PRODUCTION: move this to a dedicated encrypted column on `BrokerConnection`
 * (e.g. `metaApiTokenEnc String`, written with the same `encryptCredential`
 * envelope) or, better, to a secrets manager (AWS Secrets Manager / KMS) keyed by
 * the account id, and keep Redis only as a short-lived write-through cache.
 * `saveBrokerToken` / `loadBrokerToken` below are the only two functions that need
 * to change for that move. Do NOT modify prisma/schema.prisma from this module.
 * ========================================================================
 *
 * A connection with no per-account token falls back to the platform-level
 * `METAAPI_TOKEN` from the environment (a MetaApi account-scoped token narrows
 * that down; both are accepted by the SDK).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrokerConnection } from '@prisma/client';
import { serverEnv } from '@/lib/env';
import { ApiError } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { decryptCredential, encryptCredential } from '@/lib/crypto/credential-cipher';
import { toPrismaDecimal } from '@/lib/money';
import { getSetting } from '../settings/settings.service';
import { WS_EVENTS } from '@/lib/contracts';
import {
  ADMIN_ROOM,
  investmentRoom,
  publishActivity,
  publishBrokerStatus,
  publishTick,
  publishTradeEvent,
} from '@/server/ws/event-bus';
import { AUDIT, recordAudit } from '../audit/audit.service';
import { MetaApiBrokerAdapter } from './metaapi.adapter';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerEnvironment,
  BrokerEventHandlers,
} from './broker.types';
import type { ActivitySeverity, BotActivity } from '../bot/bot.types';

/** Redis namespace for the encrypted per-account MetaApi token. */
export function brokerTokenKey(metaApiAccountId: string): string {
  return rkey('broker-token', metaApiAccountId);
}

/** Encrypt + persist the MetaApi token for one account. See the header note. */
export async function saveBrokerToken(metaApiAccountId: string, token: string): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw ApiError.badRequest('A MetaApi token is required to register a broker connection.');
  }
  await redis.set(brokerTokenKey(metaApiAccountId), encryptCredential(token, 'metaapi'));
}

/** Read + decrypt the stored token. Returns null when nothing is stored. */
export async function loadBrokerToken(metaApiAccountId: string): Promise<string | null> {
  const stored = await redis.get(brokerTokenKey(metaApiAccountId));
  if (!stored) return null;
  try {
    return decryptCredential(stored, 'metaapi');
  } catch (err) {
    console.error(
      `[broker.registry] stored token for account ${metaApiAccountId} could not be decrypted:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function deleteBrokerToken(metaApiAccountId: string): Promise<void> {
  await redis.del(brokerTokenKey(metaApiAccountId));
}

// ---------------------------------------------------------------- adapter cache

/** One live adapter per MetaApi account id (in-process only). */
const adapterCache = new Map<string, BrokerAdapter>();

function asEnvironment(value: string): BrokerEnvironment {
  if (value === 'LIVE' || value === 'DEMO') return value;
  // An unknown environment string is never guessed at: LIVE money must not be
  // traded because a row said "live-ish".
  throw ApiError.brokerUnavailable(`Unsupported broker environment "${value}" on this connection.`);
}

/**
 * Adapter for a stored connection. Constructs (and caches) it on first use; the
 * caller connects it with `ensureBrokerConnected`.
 */
export async function getAdapterForConnection(conn: BrokerConnection): Promise<BrokerAdapter> {
  const cached = adapterCache.get(conn.metaApiAccountId);
  if (cached) return cached;

  const env = serverEnv();
  const stored = await loadBrokerToken(conn.metaApiAccountId);
  // Per-account token first, then the platform token: admin console → Settings,
  // then the METAAPI_TOKEN environment variable.
  const token = stored ?? (getSetting('metaapi.token') || env.METAAPI_TOKEN);
  if (!token) {
    throw ApiError.brokerUnavailable(`No MetaApi token available for account ${conn.metaApiAccountId}.`);
  }

  const adapter = new MetaApiBrokerAdapter({
    accountId: conn.metaApiAccountId,
    brokerName: conn.brokerName,
    environment: asEnvironment(conn.environment),
    token,
    region: env.METAAPI_REGION,
    terminalTimeout: env.METAAPI_TERMINAL_TIMEOUT,
  });
  adapterCache.set(conn.metaApiAccountId, adapter);
  return adapter;
}

/** Drops the cached adapter (used after a connection is re-added or removed). */
export async function evictAdapter(metaApiAccountId: string): Promise<void> {
  const adapter = adapterCache.get(metaApiAccountId);
  adapterCache.delete(metaApiAccountId);
  if (adapter) {
    try {
      await adapter.disconnect();
    } catch (err) {
      console.error('[broker.registry] adapter disconnect failed:', err instanceof Error ? err.message : err);
    }
  }
}

/** Idempotently connects an adapter with the standard event-bus handlers. */
export async function ensureBrokerConnected(adapter: BrokerAdapter): Promise<BrokerAdapter> {
  if (!adapter.isConnected()) {
    await adapter.connect(brokerEventHandlers(adapter.accountId));
  }
  return adapter;
}

// ------------------------------------------------------------------- activities

/** Shared `BotActivity` factory (the socket runtime supplies the delivery). */
export function makeActivity(
  action: string,
  message: string,
  severity: ActivitySeverity,
  details: Record<string, unknown> = {},
  rooms: string[] = [ADMIN_ROOM],
): BotActivity {
  return {
    id: randomUUID(),
    action,
    message,
    severity,
    details,
    createdAt: new Date().toISOString(),
    rooms,
  };
}

/** Room set for activity that belongs to one client investment. */
export function investmentRooms(investmentId: string | null): string[] {
  return investmentId ? [investmentRoom(investmentId), ADMIN_ROOM] : [ADMIN_ROOM];
}

/**
 * Standard bridge-event wiring: MetaApi streaming events → socket runtime.
 * Kept here so every consumer of `getAdapterForConnection` publishes identically.
 */
export function brokerEventHandlers(accountId: string): BrokerEventHandlers {
  const lastConnectionState = new Map<string, string>();

  return {
    onPositionOpened: async (position) => {
      await publishTradeEvent(
        WS_EVENTS.positionOpened,
        {
          positionId: position.positionId,
          investmentId: position.investmentId,
          instrument: position.instrument,
          direction: position.direction,
          volume: position.volume,
          entryPrice: position.entryPrice,
          openedAt: position.openedAt.toISOString(),
        },
        investmentRooms(position.investmentId),
      );
      await publishActivity(
        makeActivity(
          'POSITION_OPENED',
          `Broker opened ${position.direction} ${position.volume} ${position.instrument} @ ${position.entryPrice}`,
          'info',
          { positionId: position.positionId, investmentId: position.investmentId },
          investmentRooms(position.investmentId),
        ),
      );
    },

    onPositionUpdated: async (position) => {
      await publishTradeEvent(
        WS_EVENTS.positionUpdated,
        {
          positionId: position.positionId,
          investmentId: position.investmentId,
          instrument: position.instrument,
          currentPrice: position.currentPrice,
          unrealizedPnL: position.unrealizedPnL,
          swap: position.swap,
          commission: position.commission,
        },
        investmentRooms(position.investmentId),
      );
    },

    onPositionClosed: async (args) => {
      await publishTradeEvent(
        WS_EVENTS.positionClosed,
        {
          positionId: args.positionId,
          investmentId: args.investmentId,
          netPnL: args.deal?.netPnL ?? null,
          exitPrice: args.deal?.price ?? null,
          dealId: args.deal?.dealId ?? null,
        },
        investmentRooms(args.investmentId),
      );
      await publishActivity(
        makeActivity(
          'POSITION_CLOSED',
          `Broker closed position ${args.positionId}${args.deal ? ` (deal ${args.deal.dealId})` : ''}`,
          'info',
          {
            positionId: args.positionId,
            investmentId: args.investmentId,
            netPnL: args.deal?.netPnL ?? null,
          },
          investmentRooms(args.investmentId),
        ),
      );
    },

    onQuote: async (quote) => {
      // Ticks are symbol-scoped, not user-scoped: the socket layer fans them out
      // to every authenticated client, which filters by symbol.
      await publishTick({ ...quote });
    },

    onConnectionState: async (state) => {
      const previous = lastConnectionState.get(accountId);
      lastConnectionState.set(accountId, state.state);
      await publishBrokerStatus({ accountId, connected: state.connected, state: state.state });
      if (previous !== state.state) {
        await publishActivity(
          makeActivity(
            'BROKER_STATUS',
            `MetaApi connection state: ${state.state}`,
            state.connected ? 'success' : 'warning',
            { accountId, state: state.state },
            [ADMIN_ROOM],
          ),
        );
      }
    },
  };
}

// --------------------------------------------------------------- admin mutation

const addBrokerConnectionSchema = z.object({
  metaApiAccountId: z.string().min(1).max(128),
  brokerName: z.string().min(1).max(64),
  environment: z.enum(['LIVE', 'DEMO']),
  token: z.string().min(1),
  ip: z.string().max(64).nullable().optional(),
  adminUserId: z.string().min(1),
});

export type AddBrokerConnectionInput = z.input<typeof addBrokerConnectionSchema>;

/**
 * Registers (or re-registers) a MetaApi account.
 *
 * `maskedAccount`, `balance`, `equity`, `freeMargin` and `status` come from a live
 * account-information probe — if the probe fails nothing is persisted, because a
 * placeholder mask/balance must never reach the admin UI.
 */
export async function addBrokerConnection(input: AddBrokerConnectionInput): Promise<BrokerConnection> {
  const parsed = addBrokerConnectionSchema.parse(input);

  await evictAdapter(parsed.metaApiAccountId);
  await saveBrokerToken(parsed.metaApiAccountId, parsed.token);

  const env = serverEnv();
  const adapter = new MetaApiBrokerAdapter({
    accountId: parsed.metaApiAccountId,
    brokerName: parsed.brokerName,
    environment: parsed.environment,
    token: parsed.token,
    region: env.METAAPI_REGION,
    terminalTimeout: env.METAAPI_TERMINAL_TIMEOUT,
  });

  let state: BrokerAccountState;
  try {
    await adapter.connect(brokerEventHandlers(parsed.metaApiAccountId));
    state = await adapter.getAccountState();
  } catch (err) {
    await deleteBrokerToken(parsed.metaApiAccountId);
    await recordAudit({
      action: AUDIT.BROKER_ERROR,
      userId: parsed.adminUserId,
      ipAddress: parsed.ip ?? null,
      details: {
        metaApiAccountId: parsed.metaApiAccountId,
        phase: 'add_probe',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw ApiError.brokerUnavailable(
      `Could not read account information for MetaApi account ${parsed.metaApiAccountId}; nothing was saved.`,
    );
  }

  adapterCache.set(parsed.metaApiAccountId, adapter);

  const row = await prisma.brokerConnection.upsert({
    where: { metaApiAccountId: parsed.metaApiAccountId },
    create: {
      metaApiAccountId: parsed.metaApiAccountId,
      brokerName: parsed.brokerName,
      environment: parsed.environment,
      maskedAccount: state.maskedAccount,
      balance: toPrismaDecimal(state.balance),
      equity: toPrismaDecimal(state.equity),
      freeMargin: toPrismaDecimal(state.freeMargin),
      status: state.status,
    },
    update: {
      brokerName: parsed.brokerName,
      environment: parsed.environment,
      maskedAccount: state.maskedAccount,
      balance: toPrismaDecimal(state.balance),
      equity: toPrismaDecimal(state.equity),
      freeMargin: toPrismaDecimal(state.freeMargin),
      status: state.status,
    },
  });

  await recordAudit({
    action: AUDIT.BROKER_ADDED,
    userId: parsed.adminUserId,
    ipAddress: parsed.ip ?? null,
    details: {
      brokerConnectionId: row.id,
      metaApiAccountId: row.metaApiAccountId,
      brokerName: row.brokerName,
      environment: row.environment,
      maskedAccount: row.maskedAccount,
      balance: state.balance,
      equity: state.equity,
      currency: state.currency,
      rawState: state.rawState,
    },
  });

  return row;
}

/** Writes the broker-reported snapshot onto the connection row. */
export async function updateBrokerSnapshot(id: string, state: BrokerAccountState): Promise<void> {
  await prisma.brokerConnection.update({
    where: { id },
    data: {
      balance: toPrismaDecimal(state.balance),
      equity: toPrismaDecimal(state.equity),
      freeMargin: toPrismaDecimal(state.freeMargin),
      status: state.status,
      updatedAt: new Date(),
    },
  });

  publishBrokerStatus({
    accountId: state.accountId,
    connected: state.status === 'CONNECTED',
    status: state.status,
    balance: state.balance,
    equity: state.equity,
    freeMargin: state.freeMargin,
    currency: state.currency,
    rawState: state.rawState,
    updatedAt: state.updatedAt.toISOString(),
  });
}

/**
 * Removes a broker connection.
 *
 * The token is always deleted and the adapter disconnected. The row itself is
 * deleted only when it has no trade history (TradeRecord.brokerId is a required
 * relation); otherwise the row is kept with status DISCONNECTED so the archived
 * trades keep pointing at a real broker record.
 */
export async function removeBrokerConnection(
  id: string,
  meta?: { ip?: string | null; adminUserId?: string },
): Promise<{ removed: boolean; id: string; metaApiAccountId: string }> {
  const conn = await prisma.brokerConnection.findUnique({ where: { id } });
  if (!conn) throw ApiError.notFound('Broker connection not found.');

  const tradeCount = await prisma.tradeRecord.count({ where: { brokerId: id } });

  await deleteBrokerToken(conn.metaApiAccountId);
  await evictAdapter(conn.metaApiAccountId);

  if (tradeCount === 0) {
    await prisma.brokerConnection.delete({ where: { id } });
  } else {
    await prisma.brokerConnection.update({
      where: { id },
      data: { status: 'DISCONNECTED', updatedAt: new Date() },
    });
  }

  await recordAudit({
    action: AUDIT.BROKER_DISCONNECTED,
    userId: meta?.adminUserId ?? null,
    ipAddress: meta?.ip ?? null,
    details: {
      brokerConnectionId: conn.id,
      metaApiAccountId: conn.metaApiAccountId,
      maskedAccount: conn.maskedAccount,
      rowDeleted: tradeCount === 0,
      retainedTradeRecords: tradeCount,
    },
  });

  return { removed: tradeCount === 0, id: conn.id, metaApiAccountId: conn.metaApiAccountId };
}

/** Every stored connection, for the admin screens and the sync cycle. */
export async function listBrokerConnections(): Promise<BrokerConnection[]> {
  return prisma.brokerConnection.findMany({ orderBy: { updatedAt: 'desc' } });
}
