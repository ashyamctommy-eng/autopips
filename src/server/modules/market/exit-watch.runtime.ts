import { prisma } from '@/lib/prisma';
import { subscribePublicTicks } from '@/server/modules/market/public-market.service';
import { publishMarketQuote } from '@/server/modules/market/quote-fanout';
import type { Quote } from '@/server/modules/broker/broker.types';

/**
 * EXIT WATCH — the price subscription that keeps stop losses working with nobody watching.
 *
 * THE PROBLEM
 *   Position marking has always been TICK-DRIVEN, and the ticks came from the
 *   socket path: a client joining `market:<symbol>` acquired a stream, and the
 *   quotes it produced fanned out to `publishMarketQuote` → `markPositionPrice` →
 *   stop-loss / take-profit evaluation. With no client watching a symbol, no ticks
 *   arrived, and an open position's stop was simply not evaluated. A stop that only
 *   works while somebody has the dashboard open is not a stop.
 *
 * WHY THE PUBLIC FEED AND NOT THE BROKER STREAM
 *   The obvious fix — hold `acquireMarketSymbol()` for those symbols — would tie
 *   position SAFETY to an account-scoped broker connection. This platform executes
 *   internally (`EXECUTION_MODE=internal`): positions are opened against the
 *   client's own stake with no broker order behind them, and `getLatestPrice`
 *   already prices their fills from the public tick feed. Marking them from the
 *   same public feed keeps the two consistent and means a broker connection being
 *   down cannot leave stops unevaluated.
 *
 * WHY THE RECONCILIATION IS A DIFF
 *   `subscribePublicTicks` is REFCOUNTED: subscribing the same symbol twice takes
 *   two references and a single release leaves one behind — a leaked subscription
 *   that never stops streaming. So the sweep never re-subscribes blindly; it diffs
 *   what is held against what is needed (`planExitSubscriptions`, which is pure and
 *   tested) and touches only the difference.
 *
 * IDEMPOTENT BY DESIGN
 *   Marking uses `updateMany ... where status: OPEN`, so two processes marking the
 *   same symbol cannot double-close a position, and the worker runs one replica
 *   anyway. That is why this runtime takes no distributed lock, unlike the bot and
 *   maturity runtimes which must not double-process.
 */

/** How often the held subscription set is reconciled against the open book. */
const SWEEP_INTERVAL_MS = 30_000;

export interface ExitWatchStatus {
  started: boolean;
  reason?: string;
  intervalSeconds: number;
  /** Symbols currently subscribed for exit evaluation. */
  watchedSymbols: string[];
  lastSweepAt?: string;
  sweeps: number;
  lastError?: string | null;
}

export interface ExitSubscriptionsPlan {
  acquire: string[];
  release: string[];
}

/**
 * What has to change to move from `held` to `needed`. Pure, so the refcount-leak
 * rule above is testable without a broker, a database or a socket.
 */
export function planExitSubscriptions(
  held: readonly string[],
  needed: readonly string[],
): ExitSubscriptionsPlan {
  const heldSet = new Set(held);
  const neededSet = new Set(needed);
  return {
    acquire: Array.from(neededSet)
      .filter((symbol) => !heldSet.has(symbol))
      .sort(),
    release: Array.from(heldSet)
      .filter((symbol) => !neededSet.has(symbol))
      .sort(),
  };
}

/** Distinct symbols with at least one OPEN position. */
export async function openPositionSymbols(): Promise<string[]> {
  const rows = await prisma.position.findMany({
    where: { status: 'OPEN' },
    select: { symbol: true },
    distinct: ['symbol'],
  });
  return rows.map((row) => row.symbol);
}

interface HeldSubscription {
  unsubscribe: () => Promise<void>;
}

const state = {
  timer: null as NodeJS.Timeout | null,
  startedAt: null as Date | null,
  held: new Map<string, HeldSubscription>(),
  lastSweepAt: null as string | null,
  sweeps: 0,
  lastError: null as string | null,
  reason: undefined as string | undefined,
  sweeping: false,
};

/**
 * One reconciliation pass: drop subscriptions for closed positions, take one for
 * every symbol that has an open position and is not watched yet.
 *
 * A subscribe that fails is NOT recorded, so the next sweep retries it rather than
 * believing the symbol is covered.
 */
export async function sweepExitSubscriptions(): Promise<
  ExitSubscriptionsPlan & { failed: string[] }
> {
  if (state.sweeping) return { acquire: [], release: [], failed: [] };
  state.sweeping = true;

  try {
    const needed = await openPositionSymbols();
    const plan = planExitSubscriptions(Array.from(state.held.keys()), needed);

    for (const symbol of plan.release) {
      const entry = state.held.get(symbol);
      state.held.delete(symbol);
      if (entry) {
        await entry.unsubscribe().catch(() => undefined);
        console.info(`[exit-watch] released ${symbol}: no open position needs it.`);
      }
    }

    const failed: string[] = [];
    for (const symbol of plan.acquire) {
      try {
        const handle = await subscribePublicTicks(symbol, (quote: Quote) => {
          // The single fan-out point: publishes the tick AND marks every open
          // position on the symbol, which is what evaluates stops and targets.
          void publishMarketQuote(quote).catch((err: unknown) => {
            console.error(
              `[exit-watch] could not publish a quote for ${symbol}:`,
              err instanceof Error ? err.message : err,
            );
          });
        });
        state.held.set(symbol, handle);
        console.info(`[exit-watch] watching ${symbol} for stop/target evaluation.`);
      } catch (err) {
        failed.push(symbol);
        state.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[exit-watch] could not subscribe ${symbol}:`, state.lastError);
      }
    }

    state.sweeps += 1;
    state.lastSweepAt = new Date().toISOString();
    return { ...plan, failed };
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error('[exit-watch] sweep failed:', state.lastError);
    return { acquire: [], release: [], failed: [] };
  } finally {
    state.sweeping = false;
  }
}

export function exitWatchStatus(): ExitWatchStatus {
  return {
    started: state.startedAt !== null,
    reason: state.reason,
    intervalSeconds: Math.round(SWEEP_INTERVAL_MS / 1000),
    watchedSymbols: Array.from(state.held.keys()).sort(),
    lastSweepAt: state.lastSweepAt ?? undefined,
    sweeps: state.sweeps,
    lastError: state.lastError,
  };
}

/**
 * Start the watch. Answers `ALREADY_RUNNING` on a second call rather than
 * starting a second interval, so the boot supervisor cannot double-subscribe.
 */
export async function startExitWatch(): Promise<{ started: boolean; reason?: string }> {
  if (state.timer || state.startedAt) {
    return { started: true, reason: 'ALREADY_RUNNING' };
  }

  state.startedAt = new Date();
  state.reason = undefined;

  // Reconcile immediately: a position opened before this process booted must be
  // covered now, not in 30 seconds.
  await sweepExitSubscriptions();

  state.timer = setInterval(() => {
    void sweepExitSubscriptions();
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep.
  state.timer.unref?.();

  return { started: true };
}

/** Stop the watch and release every subscription it holds. */
export async function stopExitWatch(reason = 'requested'): Promise<ExitWatchStatus> {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  const held = Array.from(state.held.values());
  state.held.clear();
  await Promise.all(held.map((entry) => entry.unsubscribe().catch(() => undefined)));

  state.startedAt = null;
  state.reason = reason;
  console.info(`[exit-watch] stopped (${reason}); released ${held.length} subscription(s).`);
  return exitWatchStatus();
}
