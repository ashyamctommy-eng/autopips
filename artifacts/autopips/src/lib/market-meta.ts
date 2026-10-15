import type { InstrumentInfo } from '@/types/broker.types';

/**
 * MARKET PRESENTATION METADATA.
 *
 * The Markets table is a *presentation* of the feed's instruments, so every naming
 * decision lives here rather than in the component: which tab an instrument
 * belongs to, its ticker, its human description, and which icon represents it.
 *
 * NOTHING HERE INVENTS A PRICE OR AN INSTRUMENT. It only renames what the feed
 * already listed — a symbol with no description still renders, under its own
 * ticker, with a generic icon.
 */

export type MarketCategoryId =
  | 'favorites'
  | 'forex'
  | 'metals'
  | 'crypto'
  | 'indices'
  | 'oil'
  | 'synthetic';

export interface MarketCategory {
  id: MarketCategoryId;
  label: string;
}

/**
 * The tab strip. `VOLATILITY` is an addition to the requested set: this platform's
 * core instruments are Deriv synthetics, and without their own tab they would be
 * unreachable from the Markets page.
 */
export const MARKET_CATEGORIES: readonly MarketCategory[] = [
  { id: 'favorites', label: '★ Favorites' },
  { id: 'forex', label: 'FOREX' },
  { id: 'metals', label: 'METALS' },
  { id: 'crypto', label: 'CRYPTO' },
  { id: 'indices', label: 'EQUITY INDEXES' },
  { id: 'oil', label: 'SPOT OIL' },
  { id: 'synthetic', label: 'VOLATILITY' },
];

const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  USD: 'US Dollar',
  EUR: 'Euro',
  GBP: 'British Pound',
  JPY: 'Japanese Yen',
  AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc',
  NZD: 'New Zealand Dollar',
  MXN: 'Mexican Peso',
  PLN: 'Polish Zloty',
  SEK: 'Swedish Krona',
  NOK: 'Norwegian Krone',
  DKK: 'Danish Krone',
  CZK: 'Czech Koruna',
  HUF: 'Hungarian Forint',
  TRY: 'Turkish Lira',
  ZAR: 'South African Rand',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  CNH: 'Chinese Yuan',
  INR: 'Indian Rupee',
};

/** Flag emoji per currency. A currency we do not know simply gets no flag. */
const CURRENCY_FLAGS: Readonly<Record<string, string>> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  AUD: '🇦🇺',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
  NZD: '🇳🇿',
  MXN: '🇲🇽',
  PLN: '🇵🇱',
  SEK: '🇸🇪',
  NOK: '🇳🇴',
  DKK: '🇩🇰',
  CZK: '🇨🇿',
  HUF: '🇭🇺',
  TRY: '🇹🇷',
  ZAR: '🇿🇦',
  SGD: '🇸🇬',
  HKD: '🇭🇰',
  CNH: '🇨🇳',
  INR: '🇮🇳',
};

const METAL_NAMES: Readonly<Record<string, string>> = {
  XAU: 'Gold',
  XAG: 'Silver',
  XPD: 'Palladium',
  XPT: 'Platinum',
};

const CRYPTO_NAMES: Readonly<Record<string, string>> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  LTC: 'Litecoin',
  XRP: 'Ripple',
  BCH: 'Bitcoin Cash',
  ADA: 'Cardano',
  DOT: 'Polkadot',
  DOGE: 'Dogecoin',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  MATIC: 'Polygon',
};

const INDEX_NAMES: Readonly<Record<string, string>> = {
  OTC_NDX: 'US Tech 100',
  OTC_SPC: 'US 500',
  OTC_DJI: 'Wall Street 30',
  OTC_FTSE: 'UK 100',
  OTC_GDAXI: 'Germany 40',
  OTC_FCHI: 'France 40',
  OTC_AEX: 'Netherlands 25',
  OTC_HSI: 'Hong Kong 50',
  OTC_N225: 'Japan 225',
  OTC_AS51: 'Australia 200',
  OTC_SSMI: 'Swiss 20',
  OTC_SX5E: 'Euro 50',
};

export type MarketIcon =
  | { kind: 'flags'; base: string; quote: string }
  | { kind: 'asset'; asset: string }
  | { kind: 'index'; label: string }
  | { kind: 'synthetic'; label: string };

export interface MarketVisual {
  category: MarketCategoryId;
  /** Bold primary title, e.g. `EUR/USD`, `BTCUSD`, `XAU/USD`. */
  ticker: string;
  /** Muted subtitle, e.g. `Euro vs US Dollar`. */
  subtitle: string;
  icon: MarketIcon;
  /** Text used by search/sort. */
  search: string;
}

/** Strip the platform/vendor prefixes from a broker symbol. */
function bare(symbol: string): string {
  return symbol.replace(/^(frx|cry|com|stock)/, '').toUpperCase();
}

function currencyName(code: string): string {
  return CURRENCY_NAMES[code] ?? code;
}

export function flagFor(code: string): string | null {
  return CURRENCY_FLAGS[code] ?? null;
}

function syntheticVisual(symbol: string, displayName: string): { ticker: string; subtitle: string } {
  const r = /^R_(\d+)$/.exec(symbol);
  if (r) return { ticker: symbol, subtitle: `Volatility ${r[1]} Index` };
  const s1 = /^1HZ(\d+)V$/.exec(symbol);
  if (s1) return { ticker: symbol, subtitle: `Volatility ${s1[1]} (1s) Index` };
  const boom = /^BOOM(\d+)/.exec(symbol);
  if (boom) return { ticker: symbol, subtitle: `Boom ${boom[1]} Index` };
  const crash = /^CRASH(\d+)/.exec(symbol);
  if (crash) return { ticker: symbol, subtitle: `Crash ${crash[1]} Index` };
  const jd = /^JD(\d+)/.exec(symbol);
  if (jd) return { ticker: symbol, subtitle: `Jump ${jd[1]} Index` };
  const rb = /^RB(\d+)/.exec(symbol);
  if (rb) return { ticker: symbol, subtitle: `Range Break ${rb[1]} Index` };
  if (/^stpRNG/i.test(symbol)) return { ticker: symbol, subtitle: 'Step Index' };
  const wld = /^WLD([A-Z]{3})$/.exec(symbol);
  if (wld) return { ticker: symbol, subtitle: `World Index ${wld[1]}` };
  return { ticker: symbol, subtitle: displayName || 'Synthetic index' };
}

/**
 * Resolve one instrument's tab, ticker, subtitle and icon.
 *
 * The category is decided from the feed's own `market`/`submarket` first (it is
 * authoritative) and only falls back to the symbol's shape when the feed says
 * something unexpected.
 */
export function describeInstrument(instrument: InstrumentInfo): MarketVisual {
  const symbol = instrument.symbol;
  const upper = symbol.toUpperCase();
  const display = instrument.displayName ?? '';
  const market = instrument.market ?? '';
  const submarket = instrument.submarket ?? '';

  // ── spot oil FIRST ───────────────────────────────────────────────────────────
  // These are `commodities` instruments, so the metals branch below would claim
  // them on the feed's market alone. Oil is identified by its own symbol, which is
  // specific, so it is decided first.
  if (/^(com)?(WTIUSD|USOIL)$/i.test(upper)) {
    return {
      category: 'oil',
      ticker: 'WTI/USD',
      subtitle: 'Crude Oil WTI',
      icon: { kind: 'asset', asset: 'OIL' },
      search: 'wti oil crude',
    };
  }
  if (/^(com)?(BRENTUSD|UKOIL)$/i.test(upper)) {
    return {
      category: 'oil',
      ticker: 'BRENT/USD',
      subtitle: 'Crude Oil Brent',
      icon: { kind: 'asset', asset: 'BRENT' },
      search: 'brent oil crude',
    };
  }

  // ── metals: the feed files gold/silver under commodities/metals ──────────────
  const metalMatch = /^(XAU|XAG|XPD|XPT)([A-Z]{3})$/.exec(bare(symbol));
  if (metalMatch || market === 'commodities') {
    const base = metalMatch?.[1] ?? '';
    const quote = metalMatch?.[2] ?? 'USD';
    const name = METAL_NAMES[base];
    if (name) {
      return {
        category: 'metals',
        ticker: `${base}/${quote}`,
        subtitle: `${name} vs ${currencyName(quote)}`,
        icon: { kind: 'asset', asset: base },
        search: `${base}${quote} ${name}`.toLowerCase(),
      };
    }
    // An unknown commodity: name it from the feed rather than dropping it.
    return {
      category: 'metals',
      ticker: symbol,
      subtitle: display || 'Commodity',
      icon: { kind: 'asset', asset: 'XAU' },
      search: `${symbol} ${display}`.toLowerCase(),
    };
  }

  // ── crypto ───────────────────────────────────────────────────────────────────
  if (market === 'cryptocurrency' || /^cry/i.test(symbol)) {
    const parts = /([A-Z]+)([A-Z]{3})$/.exec(bare(symbol));
    const base = parts?.[1] ?? bare(symbol);
    const quote = parts?.[2] ?? 'USD';
    const name = CRYPTO_NAMES[base] ?? base;
    return {
      category: 'crypto',
      ticker: `${base}${quote}`,
      subtitle: `${name} vs ${currencyName(quote)}`,
      icon: { kind: 'asset', asset: base },
      search: `${base}${quote} ${name}`.toLowerCase(),
    };
  }

  // ── index CFDs ───────────────────────────────────────────────────────────────
  if (market === 'indices' || /^OTC_/i.test(symbol)) {
    const name = INDEX_NAMES[upper] ?? display ?? upper;
    return {
      category: 'indices',
      ticker: upper.replace(/^OTC_/, ''),
      subtitle: name,
      icon: { kind: 'index', label: upper.replace(/^OTC_/, '').slice(0, 3) },
      search: `${upper} ${name}`.toLowerCase(),
    };
  }

  // ── forex pairs (and anything else shaped like one) ──────────────────────────
  if (market === 'forex' || /^[A-Z]{6}$/.test(bare(symbol))) {
    const pair = /^([A-Z]{3})([A-Z]{3})$/.exec(bare(symbol));
    if (pair) {
      const [, base, quote] = pair;
      return {
        category: 'forex',
        ticker: `${base}/${quote}`,
        subtitle: `${currencyName(base)} vs ${currencyName(quote)}`,
        icon: { kind: 'flags', base, quote },
        search: `${base}${quote} ${currencyName(base)} ${currencyName(quote)}`.toLowerCase(),
      };
    }
  }

  // ── synthetics (this platform's core) ────────────────────────────────────────
  if (market === 'synthetic_index' || /^(R_|1HZ|BOOM|CRASH|JD|RB|stp)/i.test(symbol)) {
    const visual = syntheticVisual(symbol, display);
    return {
      category: 'synthetic',
      ...visual,
      icon: { kind: 'synthetic', label: visual.ticker.slice(0, 3).toUpperCase() },
      search: `${visual.ticker} ${visual.subtitle}`.toLowerCase(),
    };
  }

  // ── fallback: keep it visible rather than dropping it ────────────────────────
  return {
    category: 'synthetic',
    ticker: upper,
    subtitle: display || 'Instrument',
    icon: { kind: 'synthetic', label: upper.slice(0, 3) },
    search: `${upper} ${display}`.toLowerCase(),
  };
}

/** Assets we draw our own glyph for (brand colours, simple marks). */
export const ASSET_GLYPHS: Readonly<Record<string, { glyph: string; className: string }>> = {
  BTC: { glyph: '₿', className: 'bg-[#F7931A]/15 text-[#F7931A]' },
  ETH: { glyph: 'Ξ', className: 'bg-[#627EEA]/15 text-[#627EEA]' },
  SOL: { glyph: '◎', className: 'bg-[#9945FF]/15 text-[#9945FF]' },
  LTC: { glyph: 'Ł', className: 'bg-[#345D9D]/15 text-[#345D9D]' },
  XRP: { glyph: '✕', className: 'bg-[#23292F]/15 text-base-100' },
  XAU: { glyph: 'Au', className: 'bg-[#D4AF37]/15 text-[#9A7B1F]' },
  XAG: { glyph: 'Ag', className: 'bg-base-700/60 text-muted' },
  XPD: { glyph: 'Pd', className: 'bg-base-700/60 text-muted' },
  XPT: { glyph: 'Pt', className: 'bg-base-700/60 text-muted' },
  OIL: { glyph: '🛢', className: 'bg-warn/15 text-warn' },
  BRENT: { glyph: '🛢', className: 'bg-warn/15 text-warn' },
};

export function assetGlyph(asset: string): { glyph: string; className: string } {
  return ASSET_GLYPHS[asset] ?? { glyph: asset.slice(0, 2), className: 'bg-base-700/40 text-muted' };
}
