import { getSetting } from '@/server/modules/settings/settings.service';
import type { Candle } from '@/server/modules/broker/broker.types';
import {
  TWELVE_DATA_CREDITS_PER_MINUTE,
  twelveDataApiKey,
  twelveDataClientStats,
  twelveDataFetch,
  type TwelveDataFetchDeps,
} from './twelve-data.client';

export { twelveDataApiKey };

/**
 * Twelve Data — candles, quotes and asset catalogs.
 *
 * All HTTP goes through `twelve-data.client.ts`, which owns the free-tier credit
 * budget (8/minute) and the response cache. Nothing here calls `fetch` directly,
 * so no caller can accidentally bypass the limiter.
 *
 * THE FEED IS A SWITCH, NOT A REPLACEMENT
 * ---------------------------------------
 * The platform's universe also contains DERIV SYNTHETIC INDICES (`R_10`, `R_100`)
 * that no external vendor carries. So the instrument set is split:
 *   • mapped symbols (forex/metals/commodities/crypto) → Twelve Data;
 *   • synthetics → the Deriv public feed, as a price oracle only.
 * `MARKET_DATA_PROVIDER=twelve` therefore means "Twelve Data for everything it
 * can price", with the caller falling back for the rest — never a silent guess.
 *
 * ZERO FABRICATION is preserved: every number comes off the wire. A row with an
 * unparsable timestamp or a non-finite OHLC field is DROPPED and counted.
 */

export type MarketDataProvider = 'deriv' | 'twelve';

/** Which feed answers historical candles. Defaults to the existing Deriv feed. */
export function marketDataProvider(): MarketDataProvider {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'twelve' ? 'twelve' : 'deriv';
}

/**
 * The instruments this feed can serve, keyed by the platform's broker symbol.
 *
 * EXPLICIT AND CLOSED ON PURPOSE. Twelve Data names FX/metals as `XAU/USD`,
 * commodities as `WTI`/`BRENT` and crypto as `BTC/USD`; there is no safe
 * algorithmic mapping from `frxXAUUSD`. Adding an instrument is a deliberate edit.
 * Deriv synthetics (`R_10`, `R_100`) are intentionally absent — Twelve Data does
 * not carry them, and a proxy would price something the client did not choose.
 */
export const TWELVE_DATA_SYMBOLS: Readonly<Record<string, string>> = {
  frxXAUUSD: 'XAU/USD',
  frxXAGUSD: 'XAG/USD',
  frxEURUSD: 'EUR/USD',
  frxGBPUSD: 'GBP/USD',
  frxUSDJPY: 'USD/JPY',
  frxAUDUSD: 'AUD/USD',
  frxUSDCAD: 'USD/CAD',
  frxUSDCHF: 'USD/CHF',
  frxNZDUSD: 'NZD/USD',
  // Commodities (Twelve Data `/commodities`). Platform symbol prefix `com`.
  //
  // VERIFIED AGAINST THE LIVE CATALOG (2026-09-26): the correct symbols are
  // `WTI/USD` (Crude Oil WTI Spot) and `XBR/USD` (Brent Spot). The bare `WTI`
  // symbol is a DIFFERENT instrument and pricing it would have marked positions
  // against the wrong market. Both correct symbols are **plan-gated**: on the
  // Basic plan they answer `404 … available starting with the Grow or Venture
  // plan`, so they are NOT in the default curated list — a plan upgrade is all
  // that is needed to offer them.
  comWTIUSD: 'WTI/USD',
  comBRENTUSD: 'XBR/USD',
  // No natural-gas symbol exists in the Twelve Data commodities catalog, so no
  // mapping is invented for one.
  cryBTCUSD: 'BTC/USD',
  cryETHUSD: 'ETH/USD',
  cryLTCUSD: 'LTC/USD',
  cryXRPUSD: 'XRP/USD',
};

/**
 * The curated platform catalog: the instruments this deployment offers.
 *
 * WHY A CURATED LIST AND NOT THE FULL VENDOR CATALOG
 *   In internal execution there is no broker to enumerate instruments from, and
 *   the vendor lists thousands of rows the platform has no pricing or risk
 *   configuration for. This is the deliberate, small list that is seeded, charted
 *   and tradeable. Operators override it in Admin → Settings (`market.instruments`).
 *
 * Every entry MUST have a price source — a Twelve Data mapping above, or a
 * synthetic the oracle can price. An instrument with no feed would be offered to
 * clients and then fail to open.
 */
export const DEFAULT_PLATFORM_INSTRUMENTS: readonly string[] = [
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'frxXAUUSD',
  'cryBTCUSD',
  'cryETHUSD',
];

/**
 * Instruments whose mapping is correct but whose PRICING needs a paid plan.
 * Offered to an operator as an upgrade path, never seeded as tradeable on the
 * Basic plan (an instrument that cannot be priced must not be offered).
 */
export const PLAN_GATED_INSTRUMENTS: Readonly<Record<string, string>> = {
  comWTIUSD: 'WTI/USD — needs the Grow or Venture plan',
  comBRENTUSD: 'XBR/USD (Brent Spot) — needs the Grow or Venture plan',
  frxXAGUSD: 'XAG/USD (Silver Spot) — listed in the catalog but not priceable on this plan',
};

/** Human label used when the vendor catalog is unavailable (no network/key). */
export const PLATFORM_INSTRUMENT_LABELS: Readonly<Record<string, string>> = {
  frxEURUSD: 'Euro / US Dollar',
  frxGBPUSD: 'British Pound / US Dollar',
  frxUSDJPY: 'US Dollar / Japanese Yen',
  frxXAUUSD: 'Gold / US Dollar',
  frxXAGUSD: 'Silver / US Dollar (plan-gated)',
  comWTIUSD: 'Crude Oil WTI (plan-gated)',
  comBRENTUSD: 'Crude Oil Brent (plan-gated)',
  cryBTCUSD: 'Bitcoin / US Dollar',
  cryETHUSD: 'Ethereum / US Dollar',
};

/** The operator-curated instrument list (Admin → Settings), or the default. */
export function curatedPlatformInstruments(): string[] {
  const raw = getSetting('market.instruments').trim();
  const list = raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_PLATFORM_INSTRUMENTS];
}

/** Twelve Data symbol for a platform symbol, or null when unmapped. */
export function twelveDataSymbol(brokerSymbol: string): string | null {
  return TWELVE_DATA_SYMBOLS[brokerSymbol] ?? null;
}

/** Platform timeframe → Twelve Data `interval`, or null when unsupported. */
const TWELVE_DATA_INTERVALS: Readonly<Record<string, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
};

export function twelveDataInterval(timeframe: string): string | null {
  return TWELVE_DATA_INTERVALS[timeframe] ?? null;
}

/** Twelve Data's own ceiling for one `time_series` response. */
export const MAX_OUTPUT_SIZE = 5_000;

/** Candles change on the bar interval, so a short cache is safe and saves credits. */
const CANDLE_TTL_SECONDS = 15;
/** Quotes are live; cache only long enough to collapse a burst of readers. */
const QUOTE_TTL_SECONDS = 5;
/** Catalogs change rarely. An hour makes exploration effectively free. */
const CATALOG_TTL_SECONDS = 3_600;
/** Catalogs are large; they are cached for an hour, so patience is cheap. */
const CATALOG_TIMEOUT_MS = 25_000;

/* ─────────────────────────── pure helpers (tested) ───────────────────────── */

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A Twelve Data `datetime` → unix seconds.
 *
 * The request asks for `timezone=UTC`, so a bare `YYYY-MM-DD[ HH:MM:SS]` is
 * interpreted as UTC (NOT as server-local, which would shift every bar by the
 * host's offset). A value carrying an explicit zone is handed to `Date.parse`.
 */
export function parseTwelveDataTimestamp(datetime: string): number | null {
  const raw = datetime.trim();
  if (raw.length === 0) return null;

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!match) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface TwelveDataCandleResult {
  candles: Candle[];
  /** Rows dropped because a field was unusable. Never repaired. */
  skipped: number;
}

/**
 * Map a `time_series` `values` array to platform candles, oldest first.
 *
 * Twelve Data returns newest-first; the chart expects ascending time, so the
 * result is sorted. A row is dropped (and counted) if its timestamp or any OHLC
 * field is unusable.
 */
export function mapTwelveDataCandles(values: unknown): TwelveDataCandleResult {
  if (!Array.isArray(values)) return { candles: [], skipped: 0 };

  const candles: Candle[] = [];
  let skipped = 0;

  for (const row of values) {
    if (row === null || typeof row !== 'object') {
      skipped += 1;
      continue;
    }
    const source = row as Record<string, unknown>;
    const datetime = typeof source.datetime === 'string' ? source.datetime : null;
    const time = datetime === null ? null : parseTwelveDataTimestamp(datetime);
    const open = toFiniteNumber(source.open);
    const high = toFiniteNumber(source.high);
    const low = toFiniteNumber(source.low);
    const close = toFiniteNumber(source.close);

    if (time === null || open === null || high === null || low === null || close === null) {
      skipped += 1;
      continue;
    }

    const volume = toFiniteNumber(source.volume);
    candles.push({ time, open, high, low, close, ...(volume === null ? {} : { volume }) });
  }

  candles.sort((a, b) => a.time - b.time);
  return { candles, skipped };
}

/* ─────────────────────────────── candles ─────────────────────────────────── */

export interface TwelveDataCallOptions {
  apiKey?: string;
  baseUrl?: string;
  deps?: Partial<TwelveDataFetchDeps>;
}

/**
 * Historical candles for one platform symbol.
 *
 * Throws when the feed is unusable (no key, unmapped symbol, unsupported
 * timeframe, provider error). Callers convert that into an empty series with a
 * reason — never a synthesised one.
 */
export async function getTwelveDataCandles(
  brokerSymbol: string,
  timeframe: string,
  count: number,
  options: TwelveDataCallOptions = {},
): Promise<Candle[]> {
  // Validate the mapping BEFORE spending a credit on a request that cannot work.
  const symbol = twelveDataSymbol(brokerSymbol);
  if (!symbol) {
    throw new Error(
      `Twelve Data has no symbol mapping for "${brokerSymbol}". Add it to TWELVE_DATA_SYMBOLS, or use a feed that carries it.`,
    );
  }

  const interval = twelveDataInterval(timeframe);
  if (!interval) {
    throw new Error(`Twelve Data cannot serve the ${timeframe} timeframe.`);
  }

  const outputsize = Math.max(1, Math.min(Math.trunc(count), MAX_OUTPUT_SIZE));

  const payload = await twelveDataFetch<Record<string, unknown>>(
    'time_series',
    { symbol, interval, outputsize, timezone: 'UTC', order: 'ASC' },
    { credits: 1, ttlSeconds: CANDLE_TTL_SECONDS, ...options },
  );

  const { candles, skipped } = mapTwelveDataCandles(payload.values);
  if (skipped > 0) {
    console.warn(
      `[twelve-data] ${skipped} candle(s) for ${brokerSymbol} ${timeframe} had unusable fields and were dropped.`,
    );
  }

  return candles;
}

/* ──────────────────────────────── quotes ─────────────────────────────────── */

export interface TwelveDataQuoteResult {
  /** Platform symbol → last price. Only symbols the vendor priced are present. */
  prices: Record<string, number>;
  /** Platform symbols the vendor did not price this call. */
  missing: string[];
  /** Platform symbol → why it could not be priced (never a fabricated reason). */
  unavailable: Record<string, string>;
  /** True when a quote came from cache rather than a fresh call. */
  fromCache: boolean;
}

/**
 * Real-time prices for a set of platform symbols (`GET /price`).
 *
 * `credits = number of symbols`: the vendor meters a batch price call one credit
 * per symbol, so a 3-symbol batch spends 3 of the 8/minute budget. Callers that
 * cannot afford it should ask for fewer symbols; the client will WAIT rather than
 * fail, but waiting forever is not useful.
 */
export async function getTwelveDataQuotes(
  brokerSymbols: readonly string[],
  options: TwelveDataCallOptions = {},
): Promise<TwelveDataQuoteResult> {
  const mapped: Array<{ platform: string; twelve: string }> = [];
  const missing: string[] = [];

  for (const platform of brokerSymbols) {
    const twelve = twelveDataSymbol(platform);
    if (twelve === null) missing.push(platform);
    else mapped.push({ platform, twelve });
  }

  const unavailable: Record<string, string> = {};

  // Split out instruments we ALREADY know this plan cannot price, so a known-bad
  // symbol cannot cost us a batch (see the wholesale-404 note below).
  const priceable = mapped.filter((entry) => {
    const reason = PLAN_GATED_INSTRUMENTS[entry.platform];
    if (reason === undefined) return true;
    missing.push(entry.platform);
    unavailable[entry.platform] = reason;
    return false;
  });

  if (priceable.length === 0) return { prices: {}, missing, unavailable, fromCache: false };

  const prices: Record<string, number> = {};
  const before = twelveDataClientStats().cacheHits;

  const readBatch = (payload: Record<string, unknown>, batch: typeof priceable): void => {
    for (const entry of batch) {
      const node = payload[entry.twelve];
      // A single-symbol request answers with the price at the top level.
      const rawPrice =
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>).price
          : batch.length === 1
            ? payload.price
            : undefined;
      const price = toFiniteNumber(rawPrice);
      if (price === null) {
        missing.push(entry.platform);
        unavailable[entry.platform] = 'the vendor returned no price';
      } else {
        prices[entry.platform] = price;
      }
    }
  };

  // BATCHING: a price call costs one credit PER SYMBOL, and the limiter refuses a
  // single request larger than the whole per-minute budget (it cannot wait its
  // way out of that). So a long watchlist is split into chunks the budget can
  // actually absorb, and the limiter spaces the chunks.
  const batchSize = TWELVE_DATA_CREDITS_PER_MINUTE;
  for (let index = 0; index < priceable.length; index += batchSize) {
    const batch = priceable.slice(index, index + batchSize);
    const paramsFor = (entries: typeof priceable) => ({
      symbol: entries.map((entry) => entry.twelve).join(','),
    });

    try {
      const payload = await twelveDataFetch<Record<string, unknown>>('price', paramsFor(batch), {
        credits: batch.length,
        ttlSeconds: QUOTE_TTL_SECONDS,
        ...options,
      });
      readBatch(payload, batch);
    } catch (batchError) {
      // VERIFIED BEHAVIOUR (2026-09-26): one unavailable symbol makes the vendor
      // fail the WHOLE batch (HTTP 404 for a gated symbol), which would hide the
      // good symbols in it. So isolate by re-asking ONE symbol at a time. This
      // costs a credit per symbol, but it only runs when a batch already failed,
      // and a partial watchlist is far better than none.
      console.warn(
        `[twelve-data] batch price for ${batch.length} symbols failed (${
          batchError instanceof Error ? batchError.message : batchError
        }); retrying one symbol at a time.`,
      );

      for (const entry of batch) {
        try {
          const single = await twelveDataFetch<Record<string, unknown>>(
            'price',
            { symbol: entry.twelve },
            { credits: 1, ttlSeconds: QUOTE_TTL_SECONDS, ...options },
          );
          readBatch(single, [entry]);
        } catch (singleError) {
          missing.push(entry.platform);
          unavailable[entry.platform] =
            singleError instanceof Error ? singleError.message : 'the vendor refused the symbol';
        }
      }
    }
  }

  const fromCache = twelveDataClientStats().cacheHits > before;
  return { prices, missing, unavailable, fromCache };
}


/* ─────────────────────────────── catalogs ────────────────────────────────── */

export const TWELVE_CATALOG_KINDS = [
  'forex_pairs',
  'stocks',
  'cryptocurrencies',
  'commodities',
  'etfs',
] as const;

export type TwelveCatalogKind = (typeof TWELVE_CATALOG_KINDS)[number];

export interface TwelveCatalogEntry {
  symbol: string;
  name: string;
  kind: TwelveCatalogKind;
}

/**
 * Normalise a catalog response. The five endpoints agree on `{ data: [...] }` but
 * disagree on the label field (`name`, `currency_base`/`currency_quote`, …), so
 * each row's display name is derived with a documented fallback chain rather than
 * assumed.
 */
export function normalizeCatalogEntries(
  kind: TwelveCatalogKind,
  payload: unknown,
): TwelveCatalogEntry[] {
  if (payload === null || typeof payload !== 'object') return [];
  const rows = (payload as Record<string, unknown>).data;
  if (!Array.isArray(rows)) return [];

  const entries: TwelveCatalogEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const source = row as Record<string, unknown>;
    const symbol = typeof source.symbol === 'string' ? source.symbol.trim() : '';
    if (symbol.length === 0) continue;

    const nameCandidates = [source.name, source.instrument_name, source.currency_base];
    const name =
      (nameCandidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0) as
        | string
        | undefined) ?? symbol;

    entries.push({ symbol, name, kind });
  }
  return entries;
}

/**
 * Fetch one asset catalog.
 *
 * Cached for an hour: exploring the catalogs costs at most 5 credits an hour,
 * which leaves the 8/minute budget for candles and quotes.
 */
export async function fetchTwelveCatalog(
  kind: TwelveCatalogKind,
  options: TwelveDataCallOptions = {},
): Promise<TwelveCatalogEntry[]> {
  const payload = await twelveDataFetch<unknown>(
    kind,
    {},
    { credits: 1, ttlSeconds: CATALOG_TTL_SECONDS, timeoutMs: CATALOG_TIMEOUT_MS, ...options },
  );
  return normalizeCatalogEntries(kind, payload);
}
