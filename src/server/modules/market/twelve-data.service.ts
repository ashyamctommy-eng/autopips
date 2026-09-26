import { serverEnv } from '@/lib/env';
import { getSetting } from '@/server/modules/settings/settings.service';
import type { Candle } from '@/server/modules/broker/broker.types';

/**
 * Twelve Data — historical candles, as an ALTERNATIVE market-data feed.
 *
 * WHY THIS IS A SWITCH AND NOT A REPLACEMENT
 * ------------------------------------------
 * Twelve Data is a general market-data vendor (forex, metals, crypto, equities).
 * The platform's current universe also contains DERIV SYNTHETIC INDICES
 * (`R_10`, `R_100`, …) that no external vendor carries — they are a
 * broker-proprietary product. So "switch the feed" is really a decision about
 * WHICH INSTRUMENTS ARE LISTED, not a drop-in code change:
 *
 *   • every symbol here must be explicitly mapped (see `TWELVE_DATA_SYMBOLS`);
 *   • an unmapped symbol FAILS LOUDLY rather than being guessed at, because a
 *     wrong symbol silently prices the wrong instrument;
 *   • `MARKET_DATA_PROVIDER` defaults to `deriv`, so nothing changes until it is
 *     set deliberately.
 *
 * ZERO FABRICATION is preserved: every bar comes off the wire. A row with an
 * unparsable timestamp or a non-finite OHLC field is DROPPED and counted, never
 * repaired, and a failed request throws (the candles route turns that into an
 * empty series with `source: 'unavailable'`).
 *
 * SCOPE: this file covers HISTORICAL candles (REST). Live ticks are a separate
 * concern (see `market-stream.service.ts`) and are deliberately not switched
 * here — the tick path is demand-driven off the broker adapter and changing it
 * needs the execution-venue decision to be settled first.
 */

export type MarketDataProvider = 'deriv' | 'twelve';

/** Which feed answers historical candles. Defaults to the existing Deriv feed. */
export function marketDataProvider(): MarketDataProvider {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'twelve' ? 'twelve' : 'deriv';
}

/** Effective Twelve Data key: Admin → Settings override, else the env var. */
export function twelveDataApiKey(): string {
  return getSetting('twelve_data.api_key').trim();
}

/**
 * The instruments this feed can serve, keyed by the platform's broker symbol.
 *
 * EXPLICIT AND CLOSED ON PURPOSE. Twelve Data names FX/metals as `XAU/USD` and
 * crypto as `BTC/USD`; there is no algorithmic mapping from `frxXAUUSD` that is
 * safe to guess. Adding an instrument is a deliberate edit here.
 * Deriv synthetics (`R_10`, `R_100`) are intentionally absent — Twelve Data does
 * not carry them, and inventing a proxy for a proprietary index would price
 * something the client did not choose.
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
  cryBTCUSD: 'BTC/USD',
  cryETHUSD: 'ETH/USD',
  cryLTCUSD: 'LTC/USD',
  cryXRPUSD: 'XRP/USD',
};

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
const REQUEST_TIMEOUT_MS = 8_000;

/* ─────────────────────────── pure helpers (tested) ───────────────────────── */

/** Parse a finite number from a Twelve Data field, or null. Strings are normal. */
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

/** Build the `time_series` URL. Exported so the request shape is unit-tested. */
export function buildTwelveDataTimeSeriesUrl(input: {
  baseUrl: string;
  symbol: string;
  interval: string;
  outputsize: number;
  apiKey: string;
}): string {
  const base = input.baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    symbol: input.symbol,
    interval: input.interval,
    outputsize: String(input.outputsize),
    timezone: 'UTC',
    order: 'ASC',
    apikey: input.apiKey,
  });
  return `${base}/time_series?${params.toString()}`;
}

/* ─────────────────────────────── network ─────────────────────────────────── */

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Twelve Data answered HTTP ${response.status}.`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export interface TwelveDataDeps {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable transport for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
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
  deps: TwelveDataDeps = {},
): Promise<Candle[]> {
  const apiKey = (deps.apiKey ?? twelveDataApiKey()).trim();
  if (apiKey.length === 0) {
    throw new Error(
      'Twelve Data is selected but no API key is configured (set TWELVE_DATA_API_KEY or Admin → Settings).',
    );
  }

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
  const url = buildTwelveDataTimeSeriesUrl({
    baseUrl: deps.baseUrl ?? serverEnv().TWELVE_DATA_API_BASE,
    symbol,
    interval,
    outputsize,
    apiKey,
  });

  const payload = await (deps.fetchJson ?? fetchJson)(url);

  if (payload !== null && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    const isError = body.status === 'error' || typeof body.code === 'number';
    if (isError) {
      const message = typeof body.message === 'string' ? body.message : 'unknown error';
      // Never log the URL: it carries the API key.
      throw new Error(`Twelve Data rejected the request for ${symbol}: ${message}`);
    }
  }

  const values = payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>).values
    : undefined;

  const { candles, skipped } = mapTwelveDataCandles(values);
  if (skipped > 0) {
    console.warn(
      `[twelve-data] ${skipped} candle(s) for ${brokerSymbol} ${timeframe} had unusable fields and were dropped.`,
    );
  }

  return candles;
}
