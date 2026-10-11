import WebSocket from 'ws';

import type { Quote } from '@/server/modules/broker/broker.types';

/**
 * BIQUOTE FALLBACK FEED — a SECOND, optional live-tick source (pilot).
 *
 * WHY
 *   Live ticks come from Deriv, and only Deriv carries the synthetic indices
 *   (`R_10`…`R_100`, `1HZ*`). Deriv's public feed is nonetheless shared and
 *   rate-limited, and it quotes nothing while a market is closed. biquote.io is
 *   a free, key-less MT5-backed feed that streams FX, metals, index CFDs and
 *   crypto over SignalR — the instruments Deriv is weakest at.
 *
 * WHAT THIS IS NOT
 *   It is NOT a replacement for Deriv and it does not touch the synthetics:
 *   biquote carries `XAUUSD`, not `R_100`. It is wired as a FALLBACK — it only
 *   publishes a symbol while Deriv is not currently quoting it (see
 *   `market-stream.service.ts`), so Deriv stays authoritative wherever it works.
 *
 * HOW
 *   The hub speaks SignalR's JSON protocol: a `{"protocol":"json","version":1}`
 *   handshake record, then newline-less records terminated by 0x1e. We speak it
 *   directly over a raw WebSocket rather than pulling in `@microsoft/signalr` —
 *   the surface we need (`Subscribe`/`Unsubscribe` + `ReceiveTick` + ping) is
 *   four message types and is fully covered by the client below.
 *
 * FRESHNESS IS ENFORCED
 *   On subscribe, a closed market returns ONE snapshot carrying Friday's
 *   timestamp. That snapshot must never be published as a live tick, so every
 *   tick is dropped unless its own `timestamp` is recent (`BIQUOTE_MAX_AGE_SECONDS`,
 *   default 120). A closed market therefore contributes nothing — which is the
 *   honest outcome and matches the "market closed" handling elsewhere.
 *
 * DISABLED BY DEFAULT: set `MARKET_FALLBACK_PROVIDER=biquote` to enable.
 */

const DEFAULT_HUB_URL = 'wss://biquote.io/hubs/tick';
const DEFAULT_REST_BASE = 'https://biquote.io/api';
const RECORD_SEPARATOR = '\x1e';
const DEFAULT_MAX_AGE_SECONDS = 120;
const RECONNECT_DELAY_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * The instruments this feed can serve, keyed by the platform's broker symbol.
 *
 * EXPLICIT AND VERIFIED, mirroring `TWELVE_DATA_SYMBOLS`. Every mapping below was
 * confirmed against the live biquote catalogue (2026-10-11) — no symbol is
 * guessed. Deriv synthetics are deliberately absent: biquote does not carry them.
 */
export const BIQUOTE_SYMBOLS: Readonly<Record<string, string>> = {
  frxXAUUSD: 'XAUUSD',
  frxXAGUSD: 'XAGUSD',
  frxEURUSD: 'EURUSD',
  frxGBPUSD: 'GBPUSD',
  frxUSDJPY: 'USDJPY',
  frxAUDUSD: 'AUDUSD',
  frxUSDCAD: 'USDCAD',
  frxUSDCHF: 'USDCHF',
  frxNZDUSD: 'NZDUSD',
  comWTIUSD: 'USOIL',
  comBRENTUSD: 'UKOIL',
  cryBTCUSD: 'BTCUSD',
  cryETHUSD: 'ETHUSD',
  cryLTCUSD: 'LTCUSD',
  cryXRPUSD: 'XRPUSD',
  stockAAPL: 'AAPL',
  stockMSFT: 'MSFT',
  stockNVDA: 'NVDA',
};

const VENDOR_TO_PLATFORM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BIQUOTE_SYMBOLS).map(([platform, vendor]) => [vendor, platform]),
);

/** biquote symbol for a platform symbol, or null when this feed cannot serve it. */
export function biquoteSymbol(brokerSymbol: string): string | null {
  return BIQUOTE_SYMBOLS[brokerSymbol] ?? null;
}

/**
 * Whether the fallback feed is enabled. Read from `process.env` on every call
 * (like `marketDataProvider`) so a test can toggle it without a boot.
 */
export function biquoteFallbackEnabled(): boolean {
  return (process.env.MARKET_FALLBACK_PROVIDER ?? '').trim().toLowerCase() === 'biquote';
}

/**
 * PILOT OVERRIDE — publish biquote ticks even while Deriv is quoting.
 *
 * Only for measuring the fallback feed's coverage/latency during the pilot:
 * on a weekend every mapped instrument is closed on BOTH feeds, so the normal
 * gate stays silent and the feed cannot be observed at all. Never leave this on
 * in production — it would let a second source overwrite Deriv's prices.
 */
export function biquotePilotForce(): boolean {
  return (process.env.BIQUOTE_PILOT_FORCE ?? '').trim() === '1';
}

function hubUrl(): string {
  return (process.env.BIQUOTE_HUB_URL ?? '').trim() || DEFAULT_HUB_URL;
}

function maxAgeSeconds(): number {
  const raw = Number(process.env.BIQUOTE_MAX_AGE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_SECONDS;
}

/* ─────────────────────────────── state ─────────────────────────────── */

/** Consumer callbacks per PLATFORM symbol. */
const listeners = new Map<string, Set<(quote: Quote) => void>>();
/** VENDOR symbols the hub should be streaming for us. */
const wanted = new Set<string>();

let socket: WebSocket | null = null;
let ready = false;
let connecting: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closing = false;

/* ───────────────────────── tick translation ───────────────────────── */

interface BiquoteTick {
  symbol?: unknown;
  bid?: unknown;
  ask?: unknown;
  mid?: unknown;
  timestamp?: unknown;
}

/**
 * Translate one hub tick into the platform's `Quote`, or null when it must be
 * dropped (unknown symbol, no usable price, or stale beyond `maxAgeSeconds`).
 *
 * `now` is injectable so the freshness rule is testable without a clock.
 */
export function biquoteQuoteFromTick(tick: BiquoteTick, now = Date.now()): Quote | null {
  if (!tick || typeof tick.symbol !== 'string') return null;
  const platformSymbol = VENDOR_TO_PLATFORM[tick.symbol];
  if (!platformSymbol) return null;

  const parsed = typeof tick.timestamp === 'string' ? Date.parse(tick.timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const time = Math.floor(parsed / 1000);
  if (now / 1000 - time > maxAgeSeconds()) return null;

  const bid = typeof tick.bid === 'number' ? tick.bid : null;
  const ask = typeof tick.ask === 'number' ? tick.ask : null;
  const mid = typeof tick.mid === 'number' ? tick.mid : null;
  if (bid === null && ask === null && mid === null) return null;

  const single = bid === null && ask === null && mid !== null ? mid : undefined;
  return {
    symbol: platformSymbol,
    bid,
    ask,
    ...(single !== undefined ? { quote: single } : {}),
    time,
  };
}

/* ─────────────────────────── SignalR client ─────────────────────────── */

function send(payload: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload) + RECORD_SEPARATOR);
  }
}

function handleRecord(record: string, onHandshake: () => void): void {
  let message: { type?: unknown; target?: unknown; arguments?: unknown[]; error?: unknown };
  try {
    message = JSON.parse(record) as typeof message;
  } catch {
    return;
  }

  // Handshake acknowledgement is a bare `{}`.
  if (!ready && typeof message === 'object' && message !== null && Object.keys(message).length === 0) {
    ready = true;
    onHandshake();
    if (wanted.size > 0) {
      send({ type: 1, target: 'Subscribe', arguments: [Array.from(wanted)] });
    }
    console.info(`[biquote] connected; subscribed to ${wanted.size} symbol(s)`);
    return;
  }

  if (message.type === 6) {
    send({ type: 6 }); // ping → pong
    return;
  }

  if (message.type === 1 && message.target === 'ReceiveTick') {
    const quote = biquoteQuoteFromTick(message.arguments?.[0] as BiquoteTick);
    if (!quote) return;
    for (const listener of listeners.get(quote.symbol) ?? []) listener(quote);
    return;
  }

  if (message.type === 7) {
    console.warn(`[biquote] hub closed the connection: ${String(message.error ?? '')}`);
  }
}

function scheduleReconnect(): void {
  if (closing || reconnectTimer || listeners.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected().catch((err) => {
      console.warn(`[biquote] reconnect failed: ${err instanceof Error ? err.message : err}`);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

function openSocket(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(hubUrl());
    socket = ws;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('biquote handshake timed out'));
      try { ws.terminate(); } catch { /* already gone */ }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RECORD_SEPARATOR);
    });
    ws.on('message', (data: WebSocket.RawData) => {
      for (const record of data.toString().split(RECORD_SEPARATOR)) {
        if (record) handleRecord(record, () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } });
      }
    });
    ws.on('error', (err: Error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
    ws.on('close', () => {
      ready = false;
      socket = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('biquote socket closed before handshake')); }
      scheduleReconnect();
    });
  });
}

/** Connect (once) if there is demand. Never throws to a fire-and-forget caller. */
export async function ensureConnected(): Promise<void> {
  if (ready && socket) return;
  if (listeners.size === 0) return;
  connecting ??= openSocket();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

/* ───────────────────────────── public API ───────────────────────────── */

/**
 * Subscribe to live ticks for a platform symbol.
 *
 * Returns a no-op subscription when this feed cannot serve the symbol (e.g. a
 * Deriv synthetic), so the caller can wire it unconditionally.
 */
export function subscribeBiquoteTicks(
  brokerSymbol: string,
  onQuote: (quote: Quote) => void,
): { unsubscribe: () => void } {
  const vendor = biquoteSymbol(brokerSymbol);
  if (!vendor) return { unsubscribe: () => {} };

  let set = listeners.get(brokerSymbol);
  if (!set) {
    set = new Set();
    listeners.set(brokerSymbol, set);
  }
  set.add(onQuote);

  if (!wanted.has(vendor)) {
    wanted.add(vendor);
    if (ready) send({ type: 1, target: 'Subscribe', arguments: [[vendor]] });
  }

  void ensureConnected().catch((err) => {
    console.warn(`[biquote] could not open the fallback feed: ${err instanceof Error ? err.message : err}`);
    scheduleReconnect();
  });

  return {
    unsubscribe: () => {
      const current = listeners.get(brokerSymbol);
      if (!current) return;
      current.delete(onQuote);
      if (current.size > 0) return;
      listeners.delete(brokerSymbol);
      if (wanted.delete(vendor) && ready) {
        send({ type: 1, target: 'Unsubscribe', arguments: [[vendor]] });
      }
    },
  };
}

/** Tear the connection down (shutdown). */
export function closeBiquoteConnection(): void {
  closing = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  listeners.clear();
  wanted.clear();
  ready = false;
  try { socket?.terminate(); } catch { /* already gone */ }
  socket = null;
}

/** Observability for a health check or a log line. */
export function biquoteStatus(): { connected: boolean; symbols: number; listeners: number } {
  let count = 0;
  for (const set of listeners.values()) count += set.size;
  return { connected: ready, symbols: wanted.size, listeners: count };
}

function restBase(): string {
  return ((process.env.BIQUOTE_REST_BASE ?? '').trim() || DEFAULT_REST_BASE).replace(/\/$/, '');
}

/**
 * Session state (`marketState`) for the instruments this feed carries.
 *
 * Used for instruments the DERIV catalogue does not list (oil, the stock CFDs):
 * biquote is their price source, so its own view of whether the market is open is
 * the honest authority — better than assuming, and better than a fabricated
 * session flag. Never throws: an unreachable feed yields `{}` and the caller
 * decides the default.
 */
export async function biquoteMarketStates(
  brokerSymbols: readonly string[],
): Promise<Record<string, boolean>> {
  const mapping = brokerSymbols
    .map((symbol) => ({ symbol, vendor: biquoteSymbol(symbol) }))
    .filter((entry): entry is { symbol: string; vendor: string } => entry.vendor !== null);
  if (mapping.length === 0) return {};

  const query = mapping.map((entry) => `symbols=${encodeURIComponent(entry.vendor)}`).join('&');
  try {
    const response = await fetch(`${restBase()}/latest?${query}`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as Record<string, { marketState?: unknown } | undefined>;
    const states: Record<string, boolean> = {};
    for (const entry of mapping) {
      const state = body[entry.vendor]?.marketState;
      if (typeof state === 'string') states[entry.symbol] = state === 'open';
    }
    return states;
  } catch {
    return {};
  }
}
