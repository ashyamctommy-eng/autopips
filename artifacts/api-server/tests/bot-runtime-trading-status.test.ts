import { describe, expect, it } from 'vitest';
import {
  computeTradingStatus,
  secondsSince,
  TRADING_STALE_INTERVALS,
  type TradingStatusInput,
} from '@/server/modules/bot/bot.runtime.health';

/**
 * TRADING STATUS — the verdict `/healthz` reports.
 *
 * These are the cases the old endpoint could not distinguish: a worker that never
 * got the lock, a worker whose loop died, and a worker that is genuinely trading
 * all looked identical. Each verdict is pinned here so a stopped platform can
 * never again be reported as healthy.
 */

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

function input(overrides: Partial<TradingStatusInput> = {}): TradingStatusInput {
  return {
    started: true,
    lockHeld: true,
    startedAt: '2026-09-25T11:00:00.000Z',
    lastCycleAt: new Date(NOW - 5_000).toISOString(),
    cycleCount: 10,
    intervalSeconds: 15,
    enabledStrategies: ['gold-momentum'],
    reason: null,
    heartbeatAgeSeconds: 2,
    nowMs: NOW,
    ...overrides,
  };
}

describe('computeTradingStatus', () => {
  it('is ok when the loop is running, owns the lock and cycled recently', () => {
    const status = computeTradingStatus(input());
    expect(status.status).toBe('ok');
    expect(status.secondsSinceLastCycle).toBe(5);
  });

  it('is stopped when the loop is not running — the case that used to be invisible', () => {
    const status = computeTradingStatus(
      input({ started: false, lockHeld: false, reason: 'LOCK_HELD: another bot runtime already owns it.' }),
    );
    expect(status.status).toBe('stopped');
    expect(status.reason).toMatch(/LOCK_HELD/);
  });

  it('is degraded when running but no cycle has finished yet', () => {
    const status = computeTradingStatus(input({ lastCycleAt: null, cycleCount: 0 }));
    expect(status.status).toBe('degraded');
    expect(status.secondsSinceLastCycle).toBeNull();
  });

  it('is degraded when the last cycle is older than three intervals', () => {
    const staleMs = (15 * TRADING_STALE_INTERVALS + 1) * 1000;
    const status = computeTradingStatus(
      input({ lastCycleAt: new Date(NOW - staleMs).toISOString() }),
    );
    expect(status.status).toBe('degraded');
    expect(status.secondsSinceLastCycle).toBe(46);
  });

  it('is still ok exactly at the three-interval boundary', () => {
    const boundaryMs = 15 * TRADING_STALE_INTERVALS * 1000;
    const status = computeTradingStatus(
      input({ lastCycleAt: new Date(NOW - boundaryMs).toISOString() }),
    );
    expect(status.status).toBe('ok');
  });

  it('is degraded when running but the lock is not held any more', () => {
    const status = computeTradingStatus(input({ lockHeld: false, reason: 'lock-lost' }));
    expect(status.status).toBe('degraded');
  });

  it('carries the counters, strategy list and heartbeat age through unchanged', () => {
    const status = computeTradingStatus(
      input({ cycleCount: 7, enabledStrategies: ['gold-momentum', 'fx-eur'], heartbeatAgeSeconds: 3 }),
    );
    expect(status.cycleCount).toBe(7);
    expect(status.enabledStrategies).toEqual(['gold-momentum', 'fx-eur']);
    expect(status.heartbeatAgeSeconds).toBe(3);
  });

  it('is degraded, not ok, when the loop is healthy but NO strategy is enabled', () => {
    // A runtime with nothing to evaluate cannot place an order. Reporting `ok`
    // here would be the same "green while not trading" lie this endpoint exists
    // to eliminate, so the verdict is degraded even though the loop is cycling.
    const status = computeTradingStatus(input({ enabledStrategies: [] }));
    expect(status.status).toBe('degraded');
    expect(status.started).toBe(true);
    expect(status.lockHeld).toBe(true);
    expect(status.enabledStrategies).toEqual([]);
  });
});

describe('secondsSince', () => {
  it('returns null for a missing or unparseable timestamp', () => {
    expect(secondsSince(null, NOW)).toBeNull();
    expect(secondsSince('not-a-date', NOW)).toBeNull();
  });

  it('clamps a future timestamp to zero instead of going negative', () => {
    expect(secondsSince('2026-09-25T12:00:05.000Z', NOW)).toBe(0);
  });
});
