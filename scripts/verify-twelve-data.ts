/**
 * LIVE Twelve Data verification — run this before trusting the feed.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/verify-twelve-data.ts
 *
 * Proves four things against the REAL API (not a fixture):
 *   1. the key works and both the price and candle endpoints answer with the
 *      structures this codebase parses;
 *   2. the credit limiter (8/min on the free tier) spaces requests instead of
 *      tripping 429;
 *   3. the response cache serves a repeat read without spending a second credit;
 *   4. which asset catalogs this plan can actually read (some are paid-only —
 *      a refusal here is information, not a crash).
 *
 * It never prints the API key, and it exits non-zero if a REQUIRED check fails.
 */

import {
  twelveDataClientStats,
} from '@/server/modules/market/twelve-data.client';
import {
  TWELVE_CATALOG_KINDS,
  fetchTwelveCatalog,
  getTwelveDataCandles,
  getTwelveDataQuotes,
  twelveDataApiKey,
  type TwelveCatalogKind,
} from '@/server/modules/market/twelve-data.service';

const failures: string[] = [];
const ok = (label: string, detail: string) => console.log(`  PASS  ${label} — ${detail}`);
const bad = (label: string, detail: string) => {
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
};

function head(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  head('0. configuration');
  console.log(`  key configured: ${twelveDataApiKey().length > 0 ? 'yes' : 'NO'}`);
  if (twelveDataApiKey().length === 0) {
    console.log('  FATAL: no TWELVE_DATA_API_KEY (env or Admin → Settings).');
    process.exit(2);
  }

  head('1. price endpoint (batch)');
  const watch = ['frxEURUSD', 'frxXAUUSD', 'cryBTCUSD'];
  const quotes = await getTwelveDataQuotes(watch);
  const priced = Object.keys(quotes.prices);
  console.log(`  prices: ${JSON.stringify(quotes.prices)}`);
  if (priced.length === watch.length) ok('price', `${priced.length}/${watch.length} symbols priced`);
  else bad('price', `only priced ${priced.join(', ') || 'nothing'} (missing: ${quotes.missing.join(', ')})`);
  for (const [symbol, price] of Object.entries(quotes.prices)) {
    if (!(price > 0)) bad('price sanity', `${symbol} returned ${price}`);
  }

  head('2. time_series endpoint (OHLCV)');
  const candles = await getTwelveDataCandles('frxEURUSD', '1h', 10);
  console.log(`  bars: ${candles.length}`);
  if (candles.length === 10) ok('time_series', '10 bars returned');
  else bad('time_series', `expected 10 bars, got ${candles.length}`);

  const ascending = candles.every((bar, index) => index === 0 || bar.time >= candles[index - 1].time);
  if (candles.length > 0 && ascending) ok('bar order', 'ascending by time');
  else bad('bar order', 'bars are not ascending');

  const finite = candles.every(
    (bar) =>
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low,
  );
  if (finite) ok('bar fields', 'OHLC finite and high >= low');
  else bad('bar fields', 'a bar has a non-finite field or high < low');

  if (candles.length > 0) {
    const ageHours = Math.round((Date.now() / 1000 - candles[candles.length - 1].time) / 3600);
    console.log(`  newest bar age: ~${ageHours}h (a stale feed is a data problem, not a code one)`);
  }

  head('3. asset catalogs (which this plan can read)');
  for (const kind of TWELVE_CATALOG_KINDS) {
    try {
      const entries = await fetchTwelveCatalog(kind as TwelveCatalogKind);
      const sample = entries.slice(0, 3).map((entry) => entry.symbol).join(', ');
      if (entries.length > 0) ok(kind, `${entries.length} entries (e.g. ${sample})`);
      else bad(kind, 'empty catalog');
    } catch (err) {
      // A paid-gated catalog refuses on the free plan; report, do not crash.
      console.log(`  INFO  ${kind} — unavailable on this plan: ${err instanceof Error ? err.message : err}`);
    }
  }

  head('4. cache (a repeat read must spend no credit)');
  // Quotes cache for a few SECONDS (they are live data), so the repeat must be
  // immediate — a gap of even ten seconds legitimately re-fetches.
  await getTwelveDataQuotes(watch);
  const before = twelveDataClientStats();
  await getTwelveDataQuotes(watch);
  const after = twelveDataClientStats();
  if (after.cacheHits > before.cacheHits) ok('cache', `cacheHits ${before.cacheHits} → ${after.cacheHits}`);
  else bad('cache', 'a back-to-back quote read did not hit the cache');

  head('5. limiter + totals');
  const stats = twelveDataClientStats();
  console.log(
    `  requests=${stats.requests} cacheHits=${stats.cacheHits} waits=${stats.waits} ` +
      `rateLimitBackoffs=${stats.rateLimitBackoffs} creditsInWindow=${stats.creditsInWindow}`,
  );
  if (stats.creditsInWindow <= 8 && stats.rateLimitBackoffs === 0) {
    ok('limiter', 'never exceeded the 8-credit window and never received a 429');
  } else if (stats.rateLimitBackoffs > 0) {
    bad('limiter', `${stats.rateLimitBackoffs} rate-limit backoff(s) were needed`);
  } else {
    bad('limiter', `${stats.creditsInWindow} credits counted in the window`);
  }

  head('result');
  if (failures.length === 0) {
    console.log('  ALL REQUIRED CHECKS PASSED');
  } else {
    console.log(`  ${failures.length} FAILURE(S):`);
    for (const failure of failures) console.log(`   - ${failure}`);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error('\nUNEXPECTED FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
