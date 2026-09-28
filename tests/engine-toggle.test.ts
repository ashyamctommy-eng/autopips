import './helpers/test-env';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getSetting,
  resolvedWorkerEngineEnabled,
} from '@/server/modules/settings/settings.service';

/**
 * The engine switch — `engine.worker_enabled`.
 *
 * It exists to stop NEW trading without touching the open book, and the whole
 * point of it is the boundary: it pauses strategy generation and NOTHING else.
 * The exit path — marking open positions to market and evaluating their stop loss
 * and take profit — must keep running while the engine is paused, because a
 * switch that also silenced the exits would leave every open position unprotected.
 *
 * That boundary cannot be expressed by a runtime test without a broker, so the
 * last two tests assert it against the SOURCE: the runtime must read the setting,
 * and the exit path must never mention it. A refactor that moves the gate onto the
 * exits fails here, on the commit that does it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const FLAG = 'ENGINE_WORKER_ENABLED';
let original: string | undefined;

beforeEach(() => {
  original = process.env[FLAG];
  delete process.env[FLAG];
});

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe('engine.worker_enabled', () => {
  it('is defined and defaults to enabled, so the switch is a no-op until used', () => {
    expect(getSetting('engine.worker_enabled')).toBe('true');
    expect(resolvedWorkerEngineEnabled()).toBe(true);
  });

  it('honours the environment override, and anything other than "true" is disabled', () => {
    process.env[FLAG] = 'false';
    expect(resolvedWorkerEngineEnabled()).toBe(false);

    process.env[FLAG] = 'TRUE';
    expect(resolvedWorkerEngineEnabled()).toBe(true);

    process.env[FLAG] = 'yes';
    expect(resolvedWorkerEngineEnabled()).toBe(false);
  });
});

describe('the pause boundary', () => {
  it('is actually read by the bot runtime (a setting nothing reads is not a switch)', () => {
    const runtime = read('src/server/modules/bot/bot.runtime.ts');
    expect(runtime).toContain('resolvedWorkerEngineEnabled()');
    // The gate must be in the cycle, before the strategies are evaluated, and it
    // must complete the cycle rather than abandoning it — the heartbeat lives in
    // the cycle's `finally`, and a runtime that stops heartbeating looks dead.
    expect(runtime).toMatch(/if \(!resolvedWorkerEngineEnabled\(\)\) \{[\s\S]{0,200}return;/);
  });

  it('never reaches the exit path: stops and targets stay live while the engine is paused', () => {
    const exitPath = read('src/server/modules/positions/position.service.ts');
    expect(exitPath).not.toContain('engine.worker_enabled');
    expect(exitPath).not.toContain('resolvedWorkerEngineEnabled');
    // And the marking entry point the tick engine calls is still exported.
    expect(exitPath).toContain('export async function markPositionPrice');
  });
});
