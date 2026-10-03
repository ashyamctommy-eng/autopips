import './helpers/test-env';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { planExitSubscriptions } from '@/server/modules/market/exit-watch.runtime';

/**
 * The exit watch keeps a price subscription open for every symbol that has an
 * OPEN position, so stop-loss and take-profit levels are evaluated while nobody
 * has the dashboard open.
 *
 * The subscription primitive is REFCOUNTED, so the reconciler must never
 * re-subscribe a symbol it already holds: that would take a second reference and a
 * single release would leave a leaked stream behind, streaming forever. The first
 * test is that rule; it is the reason the sweep diffs instead of subscribing
 * blindly every cycle.
 *
 * The last test pins the design decision the module exists to make: the watch must
 * read the PUBLIC tick feed, not the account-scoped broker stream, so position
 * safety does not depend on a broker connection that internal execution does not
 * even use.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('planExitSubscriptions', () => {
  it('is a pure diff: nothing to do when the held set already matches', () => {
    expect(planExitSubscriptions(['frxXAUUSD', 'R_100'], ['R_100', 'frxXAUUSD'])).toEqual({
      acquire: [],
      release: [],
    });
  });

  it('acquires only symbols that are not held — never a re-subscription', () => {
    const plan = planExitSubscriptions(['frxXAUUSD'], ['frxXAUUSD', 'R_100', 'frxEURUSD']);
    expect(plan.acquire).toEqual(['R_100', 'frxEURUSD']);
    expect(plan.release).toEqual([]);
  });

  it('releases only symbols that no open position needs any more', () => {
    const plan = planExitSubscriptions(['frxXAUUSD', 'R_100'], ['R_100']);
    expect(plan.release).toEqual(['frxXAUUSD']);
    expect(plan.acquire).toEqual([]);
  });

  it('handles both directions at once, deterministically', () => {
    expect(planExitSubscriptions(['a', 'b'], ['b', 'c'])).toEqual({ acquire: ['c'], release: ['a'] });
  });

  it('releases everything when the book empties, and acquires from nothing', () => {
    expect(planExitSubscriptions(['frxXAUUSD'], [])).toEqual({
      acquire: [],
      release: ['frxXAUUSD'],
    });
    expect(planExitSubscriptions([], ['frxXAUUSD'])).toEqual({
      acquire: ['frxXAUUSD'],
      release: [],
    });
    expect(planExitSubscriptions([], [])).toEqual({ acquire: [], release: [] });
  });

  it('is idempotent: re-planning from the applied result yields no work', () => {
    const needed = ['frxXAUUSD', 'R_100'];
    const first = planExitSubscriptions([], needed);
    const applied = [...first.acquire];
    expect(planExitSubscriptions(applied, needed)).toEqual({ acquire: [], release: [] });
  });
});

describe('the watch reads the public feed, not the broker stream', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src/server/modules/market/exit-watch.runtime.ts'),
    'utf8',
  );

  /**
   * Source with its comments removed.
   *
   * The module's own header explains WHY the account-scoped stream is not used,
   * which means it names it — so a naive search over the whole file would match
   * the explanation and fail the very rule the explanation documents. Assert on
   * the code, not the prose.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('subscribes through the public tick feed and fans out through the single quote path', () => {
    expect(code).toContain('subscribePublicTicks');
    expect(code).toContain('publishMarketQuote');
  });

  it('does not depend on an account-scoped market stream', () => {
    // `acquireMarketSymbol` needs a CONNECTED broker connection. Internal positions
    // have no broker order behind them, so tying their exits to that path would
    // leave stops unevaluated whenever the connection is down.
    expect(code).not.toContain('acquireMarketSymbol');
  });
});
