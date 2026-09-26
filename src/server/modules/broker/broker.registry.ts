/**
 * Broker connection registry.
 *
 * Responsibilities:
 *  - turn a `BrokerConnection` row into a live `BrokerAdapter` (one adapter per
 *    Deriv login id, cached in-process);
 *  - own the admin mutations (`addBrokerConnection`, `updateBrokerSnapshot`,
 *    `removeBrokerConnection`) and the audit trail for them;
 *  - expose the single activity/event-bus wiring used by the broker + bot runtime.
 *
 * ====================== WHERE THE BROKER TOKEN LIVES =======================
 * The Prisma schema deliberately has no token column on `BrokerConnection`, so the
 * per-connection Deriv API token is stored AES-256-GCM encrypted (`encryptCredential`)
 * under the Redis key
 *   `autopips:broker-token:<derivAccountId>`
 *
 * NOTE on the cipher *purpose* string: it is still the literal `'metaapi'`, kept
 * deliberately. It is part of the key-derivation input, so renaming it would make
 * every already-encrypted token undecryptable. The DB column name
 * (`derivAccountId`) is likewise still the historical one; both are identifiers
 * with data in them, not branding, and they change only with a migration.
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
 * `DERIV_API_TOKEN` from the environment, or the token saved in Admin → Platform
 * settings. Without a token the adapter still streams public market data.
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
  publishTradeEvent,
} from '@/server/ws/event-bus';
import { AUDIT, recordAudit } from '../audit/audit.service';
import { publishMarketQuote } from '@/server/modules/market/quote-fanout';
import { DerivBrokerAdapter } from './deriv.adapter';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerEnvironment,
  BrokerEventHandlers,
} from './broker.types';
import type { ActivitySeverity, BotActivity } from '../bot/bot.types';

/** Redis namespace for the encrypted per-account MetaApi token. */
export function brokerTokenKey(derivAccountId: string): string {
  return rkey('broker-token', derivAccountId);
}

/** Encrypt + persist the MetaApi token for one account. See the header note. */
export async function saveBrokerToken(derivAccountId: string, token: string): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw ApiError.badRequest('A MetaApi token is required to register a broker connection.');
  }
  await redis.set(brokerTokenKey(derivAccountId), encryptCredential(token, 'metaapi'));
}

/** Read + decrypt the stored token. Returns null when nothing is stored. */
export async function loadBrokerToken(derivAccountId: string): Promise<string | null> {
  const stored = await redis.get(brokerTokenKey(derivAccountId));
  if (!stored) return null;
  try {
    return decryptCredential(stored, 'metaapi');
  } catch (err) {
    console.error(
      `[broker.registry] stored token for account ${derivAccountId} could not be decrypted:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function deleteBrokerToken(derivAccountId: string): Promise<void> {
  await redis.del(brokerTokenKey(derivAccountId));
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
  const cached = adapterCache.get(conn.derivAccountId);
  if (cached) return cached;

  const env = serverEnv();
  const stored = await loadBrokerToken(conn.derivAccountId);
  // Per-connection token first, then the platform token: admin console →
  // Settings, then DERIV_API_TOKEN. A token is OPTIONAL — without one the
  // adapter still streams public market data for the charts and simply cannot
  // authenticate, read balance or trade.
  const token = stored ?? (getSetting('deriv.api_token') || env.DERIV_API_TOKEN || null);

  const adapter = new DerivBrokerAdapter({
    loginId: conn.derivAccountId,
    appId: env.DERIV_APP_ID,
    token: token && token.trim().length > 0 ? token : null,
    url: env.DERIV_API_URL,
    restUrl: env.DERIV_REST_URL,
    multiplier: env.DERIV_MULTIPLIER,
    connectTimeoutMs: env.BROKER_CONNECT_TIMEOUT * 1000,
  });
  adapterCache.set(conn.derivAccountId, adapter);
  return adapter;
}

/** Drops the cached adapter (used after a connection is re-added or removed). */
export async function evictAdapter(derivAccountId: string): Promise<void> {
  const adapter = adapterCache.get(derivAccountId);
  adapterCache.delete(derivAccountId);
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
      await publishMarketQuote(quote);
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
  derivAccountId: z.string().min(1).max(128),
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

  await evictAdapter(parsed.derivAccountId);
  await saveBrokerToken(parsed.derivAccountId, parsed.token);

  const env = serverEnv();
  const adapter = new DerivBrokerAdapter({
    loginId: parsed.derivAccountId,
    appId: env.DERIV_APP_ID,
    token: parsed.token,
    url: env.DERIV_API_URL,
    restUrl: env.DERIV_REST_URL,
    multiplier: env.DERIV_MULTIPLIER,
    connectTimeoutMs: env.BROKER_CONNECT_TIMEOUT * 1000,
  });

  let state: BrokerAccountState;
  try {
    await adapter.connect(brokerEventHandlers(parsed.derivAccountId));
    state = await adapter.getAccountState();
  } catch (err) {
    await deleteBrokerToken(parsed.derivAccountId);
    await recordAudit({
      action: AUDIT.BROKER_ERROR,
      userId: parsed.adminUserId,
      ipAddress: parsed.ip ?? null,
      details: {
        derivAccountId: parsed.derivAccountId,
        phase: 'add_probe',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw ApiError.brokerUnavailable(
      `Could not read account information for Deriv account ${parsed.derivAccountId}; nothing was saved.`,
    );
  }

  adapterCache.set(parsed.derivAccountId, adapter);

  const row = await prisma.brokerConnection.upsert({
    where: { derivAccountId: parsed.derivAccountId },
    create: {
      derivAccountId: parsed.derivAccountId,
      brokerName: parsed.brokerName,
      environment: parsed.environment,
      maskedAccount: state.maskedAccount,
      balance: state.balance === null ? null : toPrismaDecimal(state.balance),
      equity: state.equity === null ? null : toPrismaDecimal(state.equity),
      freeMargin: state.freeMargin === null ? null : toPrismaDecimal(state.freeMargin),
      status: state.status,
    },
    update: {
      brokerName: parsed.brokerName,
      environment: parsed.environment,
      maskedAccount: state.maskedAccount,
      balance: state.balance === null ? null : toPrismaDecimal(state.balance),
      equity: state.equity === null ? null : toPrismaDecimal(state.equity),
      freeMargin: state.freeMargin === null ? null : toPrismaDecimal(state.freeMargin),
      status: state.status,
    },
  });

  await recordAudit({
    action: AUDIT.BROKER_ADDED,
    userId: parsed.adminUserId,
    ipAddress: parsed.ip ?? null,
    details: {
      brokerConnectionId: row.id,
      derivAccountId: row.derivAccountId,
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
      balance: state.balance === null ? null : toPrismaDecimal(state.balance),
      equity: state.equity === null ? null : toPrismaDecimal(state.equity),
      freeMargin: state.freeMargin === null ? null : toPrismaDecimal(state.freeMargin),
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
): Promise<{ removed: boolean; id: string; derivAccountId: string }> {
  const conn = await prisma.brokerConnection.findUnique({ where: { id } });
  if (!conn) throw ApiError.notFound('Broker connection not found.');

  const tradeCount = await prisma.tradeRecord.count({ where: { brokerId: id } });

  await deleteBrokerToken(conn.derivAccountId);
  await evictAdapter(conn.derivAccountId);

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
      derivAccountId: conn.derivAccountId,
      maskedAccount: conn.maskedAccount,
      rowDeleted: tradeCount === 0,
      retainedTradeRecords: tradeCount,
    },
  });

  return { removed: tradeCount === 0, id: conn.id, derivAccountId: conn.derivAccountId };
}

/** Every stored connection, for the admin screens and the sync cycle. */
export async function listBrokerConnections(): Promise<BrokerConnection[]> {
  return prisma.brokerConnection.findMany({ orderBy: { updatedAt: 'desc' } });
}
