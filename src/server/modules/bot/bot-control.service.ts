import { ApiError } from '@/lib/http';
import { D } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { getRealizedPnlToday } from '@/server/accounting/ledger';
import { AUDIT, recordAudit } from '@/server/modules/audit/audit.service';
import {
  getSetting,
  getSettingNumber,
  getSettingSymbols,
  saveAdminSetting,
} from '@/server/modules/settings/settings.service';
import { publishSystemStatus } from '@/server/ws/event-bus';

/**
 * BOT CONTROL — the global kill switch and the effective risk limits.
 *
 * WHY REDIS *AND* THE DATABASE
 *   The switch has to be obeyed by a different process from the one that sets
 *   it: the admin hits EMERGENCY STOP in the web tier, and the refusal must land
 *   in the worker's execution path. The settings cache is per-process with a
 *   30-second TTL, which is fine for a provider key and useless for an emergency
 *   stop. So:
 *
 *     • Redis holds the live state and is read UNCONDITIONALLY on every order —
 *       no cache, because orders are rare (tens a day) and ~0.5ms is nothing
 *       next to being wrong;
 *     • `PlatformSetting` holds the durable record, so a Redis restart or a
 *       flush cannot silently re-arm a stopped bot;
 *     • the operator's reason is kept with the state, because "who stopped it
 *       and why" is the first question asked afterwards;
 *     • an ADMIN_ROOM socket event updates every open console immediately.
 *
 * FAIL CLOSED
 *   If neither Redis nor the database can be read, the state is UNKNOWN and the
 *   answer is "not allowed" — a platform that cannot read its own kill switch
 *   must not keep trading. This matches how the rate-limit and replay guards
 *   already behave.
 *
 * WHAT IT DOES NOT DO
 *   Stopping the bot does not stop market data: candles and ticks keep streaming
 *   so operators can watch the market they just halted trading in. `checkTradingAllowed`
 *   gates ORDERS; the chart is unaffected on purpose.
 */

/** Live state. Read on every order, never cached. */
export const BOT_ENABLED_REDIS_KEY = rkey('bot', 'enabled');

export interface BotControlState {
  enabled: boolean;
  /** The operator's own words. Null when trading is running. */
  reason: string | null;
  /** Where the authority for `enabled` came from. */
  source: 'redis' | 'database' | 'unknown';
  checkedAt: string;
  /** Effective limits the bot enforces (0 = limit disabled). */
  maxStakeUsd: number;
  dailyLossLimitUsd: number;
  minPayoutPercentage: number;
  /** Empty = every broker symbol the connection offers. */
  allowedSymbols: string[];
}

export interface BotControlActor {
  id: string;
  email: string;
}

export type TradingGate =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

/** Live state from Redis; null when the key is absent or Redis is unreachable. */
async function readEnabledFromRedis(): Promise<boolean | null> {
  try {
    const raw = await redis.get(BOT_ENABLED_REDIS_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch (err) {
    console.error(
      `[bot-control] Redis unreadable (${err instanceof Error ? err.message : err}); falling back to the durable row.`,
    );
    return null;
  }
}

/**
 * Durable state, read straight from the table (not the settings cache).
 *
 * Returns 'unknown' only when the read FAILED. A missing row is not an unknown
 * state: a platform that has never been stopped is running, and treating
 * "no row yet" as unknown would refuse every order on a fresh deployment —
 * fail-closed on a technicality, which is not the same as failing safe.
 */
async function readEnabledFromDatabase(): Promise<boolean | 'unknown'> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: 'bot.enabled' } });
    if (!row) return true;
    return row.value.trim().toLowerCase() !== 'false';
  } catch (err) {
    console.error(
      `[bot-control] database unreadable (${err instanceof Error ? err.message : err}); bot state is unknown.`,
    );
    return 'unknown';
  }
}

function effectiveLimits() {
  return {
    maxStakeUsd: getSettingNumber('risk.max_stake_usd'),
    dailyLossLimitUsd: getSettingNumber('risk.daily_loss_limit_usd'),
    minPayoutPercentage: getSettingNumber('risk.min_payout_percentage'),
    allowedSymbols: getSettingSymbols('risk.allowed_symbols'),
  };
}

/** The effective state, with its provenance. Never throws. */
export async function getBotControlState(): Promise<BotControlState> {
  const limits = effectiveLimits();

  const fromRedis = await readEnabledFromRedis();
  if (fromRedis !== null) {
    return {
      enabled: fromRedis,
      reason: fromRedis ? null : getSetting('bot.disabled_reason') || null,
      source: 'redis',
      checkedAt: new Date().toISOString(),
      ...limits,
    };
  }

  const fromDatabase = await readEnabledFromDatabase();
  if (fromDatabase !== 'unknown') {
    return {
      enabled: fromDatabase,
      // A disabled row without a reason is possible (someone cleared the text):
      // say so rather than inventing one.
      reason: fromDatabase ? null : getSetting('bot.disabled_reason') || 'reason not recorded',
      source: 'database',
      checkedAt: new Date().toISOString(),
      ...limits,
    };
  }

  return {
    // Neither store answered: refuse, loudly.
    enabled: false,
    reason: 'Bot state could not be read from Redis or the database.',
    source: 'unknown',
    checkedAt: new Date().toISOString(),
    ...limits,
  };
}

/**
 * Engage or release the kill switch.
 *
 * Stopping REQUIRES a reason: an unexplained halt on a money platform is an
 * incident of its own. Both stores are written, the change is audited, and the
 * console is notified.
 */
export async function setBotEnabled(input: {
  enabled: boolean;
  reason?: string | null;
  actor: BotControlActor;
  ip?: string | null;
}): Promise<BotControlState> {
  const reason = (input.reason ?? '').trim();

  if (!input.enabled && reason.length < 3) {
    throw ApiError.badRequest(
      'A reason (at least 3 characters) is required to stop trading — it is shown in the console and kept in the audit log.',
    );
  }

  // Redis first: it is the value the execution path reads. A failure here is
  // reported but does not abort — the durable row is still written, and
  // `getBotControlState` prefers Redis when it exists, so a failed write would
  // leave the two stores disagreeing. That is unacceptable for a kill switch, so
  // a Redis failure IS fatal for this operation.
  try {
    await redis.set(BOT_ENABLED_REDIS_KEY, input.enabled ? '1' : '0');
  } catch (err) {
    throw ApiError.brokerUnavailable(
      `Could not write the kill switch to Redis (${err instanceof Error ? err.message : err}); nothing was changed.`,
    );
  }

  await saveAdminSetting('bot.enabled', input.enabled ? 'true' : 'false', input.actor);
  await saveAdminSetting('bot.disabled_reason', input.enabled ? '' : reason, input.actor);

  await recordAudit({
    action: input.enabled ? AUDIT.BOT_STARTED : AUDIT.RISK_KILL_SWITCH,
    userId: input.actor.id,
    ipAddress: input.ip ?? null,
    details: {
      enabled: input.enabled,
      reason: reason || null,
      actor: input.actor.email,
      // Never the whole config, just what an investigator needs.
      maxStakeUsd: getSettingNumber('risk.max_stake_usd'),
      dailyLossLimitUsd: getSettingNumber('risk.daily_loss_limit_usd'),
    },
  });

  const state = await getBotControlState();
  await publishSystemStatus({ ...state });

  console.warn(
    `[bot-control] trading ${state.enabled ? 'ENABLED' : 'DISABLED'} by ${input.actor.email}${state.reason ? ` — ${state.reason}` : ''}`,
  );

  return state;
}

/**
 * The pre-trade gate: kill switch, symbol allow-list, daily loss limit.
 *
 * Returns a verdict rather than throwing so the caller can audit and notify
 * using the same shapes it already uses for risk rejections.
 */
export async function checkTradingAllowed(symbol?: string | null): Promise<TradingGate> {
  const state = await getBotControlState();

  if (!state.enabled) {
    return {
      allowed: false,
      code: 'BOT_KILL_SWITCH',
      reason: state.reason
        ? `Trading is stopped by the platform kill switch: ${state.reason}`
        : 'Trading is stopped by the platform kill switch.',
    };
  }

  if (symbol && state.allowedSymbols.length > 0 && !state.allowedSymbols.includes(symbol)) {
    return {
      allowed: false,
      code: 'SYMBOL_NOT_ALLOWED',
      reason: `${symbol} is not in the platform's tradable-symbol allow-list.`,
    };
  }

  if (state.dailyLossLimitUsd > 0) {
    const realizedToday = await getRealizedPnlToday();
    const limit = D(-state.dailyLossLimitUsd);
    if (realizedToday.lte(limit)) {
      return {
        allowed: false,
        code: 'DAILY_LOSS_LIMIT_REACHED',
        reason: `Realised P/L today (${realizedToday.toFixed(2)}) has reached the daily loss limit of ${state.dailyLossLimitUsd.toFixed(2)}.`,
      };
    }
  }

  return { allowed: true };
}

/** Throwing wrapper for call sites where an exception is the natural shape. */
export async function assertTradingAllowed(symbol?: string | null): Promise<void> {
  const gate = await checkTradingAllowed(symbol);
  if (!gate.allowed) throw ApiError.brokerUnavailable(gate.reason);
}

/** Update one or more risk controls and notify the console. */
export async function setRiskControls(
  updates: Array<{ key: string; value: string | null }>,
  actor: BotControlActor,
): Promise<BotControlState> {
  for (const update of updates) {
    await saveAdminSetting(update.key, update.value, actor);
  }

  const state = await getBotControlState();
  await publishSystemStatus({ ...state });
  return state;
}
