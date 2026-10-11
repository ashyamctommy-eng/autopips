import { handler, ok } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { requireAdmin } from '@/server/modules/auth/session';
import { getBotControlState } from '@/server/modules/bot/bot-control.service';
import {
  BOT_RUNTIME_HEARTBEAT_KEY,
  BOT_RUNTIME_LOCK_KEY,
  readBotRuntimeHeartbeat,
  type BotRuntimeHeartbeatRead,
} from '@/server/modules/bot/bot.runtime.state';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  listBrokerConnections,
} from '@/server/modules/broker/broker.registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/bot/status
 *
 * The bot-control console's read model: the kill-switch state (with its reason
 * and provenance), the EFFECTIVE risk limits, the broker's instrument list so the
 * operator can toggle symbols without typing tickers from memory, and the RUNTIME
 * truth.
 *
 * `runtime` exists because this route runs in the WEB process, whose in-memory
 * runtime state is always empty: a worker can be happily (or not at all) trading
 * in another container and this process would not know. So the heartbeat comes
 * from Redis (`readBotRuntimeHeartbeat()`) and the lock is read directly. Without
 * it the console showed a green kill switch while the worker had silently stopped.
 *
 * `symbols` is empty when no broker connection is reachable — the console says
 * so rather than offering a fabricated list. `killSwitch` is never cached here:
 * it is the whole point that an operator sees the truth.
 */

interface BotRuntimeReport {
  /** False when Redis itself could not be read; `error` says why. */
  available: boolean;
  error?: string;
  heartbeat: BotRuntimeHeartbeatRead | null;
  heartbeatKey: string;
  lock: { key: string; held: boolean };
  /** Best effort: a worker owns the lock and its heartbeat is recent. */
  workerTrading: boolean;
}

/**
 * Reads the runtime's cross-process state. NEVER throws: an unreachable Redis
 * degrades to `{ available: false, error }` so the kill switch stays operable
 * when Redis is the thing that is broken.
 */
async function readBotRuntimeReport(): Promise<BotRuntimeReport> {
  const unavailable: BotRuntimeReport = {
    available: false,
    heartbeat: null,
    heartbeatKey: BOT_RUNTIME_HEARTBEAT_KEY,
    lock: { key: BOT_RUNTIME_LOCK_KEY, held: false },
    workerTrading: false,
  };

  try {
    const heartbeat = await readBotRuntimeHeartbeat();
    const lockToken = await redis.get(BOT_RUNTIME_LOCK_KEY);
    const held = lockToken !== null;
    return {
      available: true,
      heartbeat,
      heartbeatKey: BOT_RUNTIME_HEARTBEAT_KEY,
      lock: { key: BOT_RUNTIME_LOCK_KEY, held },
      // A worker is trading when it owns the lock AND its heartbeat is inside the
      // same ~3-interval window /healthz uses. An old heartbeat behind a valid
      // lock means a worker died without releasing it (the TTL will free it).
      workerTrading:
        held &&
        heartbeat !== null &&
        heartbeat.ageSeconds <= 3 * heartbeat.intervalSeconds,
    };
  } catch (err) {
    console.warn(
      '[admin/bot/status] runtime state unavailable:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      ...unavailable,
      error: err instanceof Error ? err.message : 'The runtime state could not be read.',
    };
  }
}

export const GET = handler(async () => {
  await requireAdmin();

  const state = await getBotControlState();
  const runtimeReport = await readBotRuntimeReport();

  let symbols: Array<{ symbol: string; displayName: string; market: string; isTradable: boolean }> = [];
  let symbolsError: string | null = null;

  try {
    if ((process.env.EXECUTION_MODE ?? 'internal') === 'internal') {
      const { listPublicSymbols } = await import('@/server/modules/market/public-market.service');
      symbols = await listPublicSymbols();
    } else {
    const connections = await listBrokerConnections();
    const connection = connections.find((row) => row.status === 'CONNECTED') ?? connections[0];
    if (connection) {
      const adapter = await ensureBrokerConnected(await getAdapterForConnection(connection));
      symbols = (await adapter.listInstruments()).map((instrument) => ({
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        market: instrument.market,
        isTradable: instrument.isTradable,
      }));
    } else {
      symbolsError = 'No broker connection is registered yet.';
    }
    }
  } catch (err) {
    // An unreachable broker must not break the console: the kill switch still
    // has to be operable when the broker is the thing that is broken.
    symbolsError = err instanceof Error ? err.message : 'The broker could not list instruments.';
    console.warn('[admin/bot/status] instrument list unavailable:', symbolsError);
  }

  // The latest engine bookings. Investment-linked only (`investmentId != null`),
  // so a client-opened position never appears here.
  let recentExecutions: RecentExecution[] = [];
  let recentExecutionsError: string | null = null;
  try {
    const rows = await prisma.position.findMany({
      where: { investmentId: { not: null } },
      orderBy: { openedAt: 'desc' },
      take: 10,
      select: {
        investmentId: true,
        symbol: true,
        side: true,
        stake: true,
        pnl: true,
        status: true,
        openedAt: true,
        strategyId: true,
        user: { select: { email: true } },
      },
    });
    recentExecutions = rows.map((row) => ({
      investmentId: row.investmentId,
      userEmail: row.user.email,
      symbol: row.symbol,
      side: row.side,
      stake: row.stake.toNumber(),
      pnl: row.pnl.toNumber(),
      status: row.status,
      openedAt: row.openedAt.toISOString(),
      strategyId: row.strategyId,
    }));
  } catch (err) {
    recentExecutionsError =
      err instanceof Error ? err.message : 'The recent executions could not be read.';
    console.warn('[admin/bot/status] recent executions unavailable:', recentExecutionsError);
  }

  // THE SIGNAL LOG. Fired signals plus the gate/sizing refusals around them, from
  // the audit trail — the console's answer to "is the engine even seeing setups?".
  let recentSignals: RecentSignal[] = [];
  let recentSignalsError: string | null = null;
  try {
    const signalRows = await prisma.auditLog.findMany({
      where: {
        action: { in: ['BOT_SIGNAL_TRIGGERED', 'RISK_KILL_SWITCH', 'STAKE_ALLOCATED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, action: true, details: true, createdAt: true },
    });
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    recentSignals = signalRows.map((row) => {
      const details = (row.details ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        action: row.action,
        createdAt: row.createdAt.toISOString(),
        strategyId: text(details.strategyId),
        symbol: text(details.symbol),
        direction: text(details.direction),
        reason:
          text(details.reason) ?? text(details.code) ?? text(details.skipReason) ?? null,
        investmentId: text(details.investmentId),
      };
    });
  } catch (err) {
    recentSignalsError =
      err instanceof Error ? err.message : 'The signal log could not be read.';
    console.warn('[admin/bot/status] recent signals unavailable:', recentSignalsError);
  }

  return ok({ killSwitch: state, runtime: runtimeReport, symbols, symbolsError, recentExecutions, recentExecutionsError, recentSignals, recentSignalsError });
});

/**
 * The latest investment-linked positions the internal engine booked, so the Bot
 * Control panel can show WHAT the engine is doing rather than only that it is
 * alive. `investmentId` is present on every row by construction (the filter
 * excludes client-opened positions).
 *
 * Read defensively: an unreadable table must not take the kill switch (the whole
 * point of this screen) down with it.
 */
interface RecentExecution {
  investmentId: string | null;
  userEmail: string | null;
  symbol: string;
  side: string;
  stake: number;
  pnl: number;
  status: string;
  openedAt: string;
  strategyId: string | null;
}

/**
 * One entry in the SIGNAL log: a fired signal, or a gate/sizing refusal that
 * explains why a fired signal produced nothing. Read out of the audit trail, so
 * this is the durable record rather than an in-memory counter.
 */
interface RecentSignal {
  id: string;
  action: string;
  createdAt: string;
  strategyId: string | null;
  symbol: string | null;
  direction: string | null;
  reason: string | null;
  investmentId: string | null;
}
