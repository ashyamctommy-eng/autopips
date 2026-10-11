import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * MARKET ASSET ICONS.
 *
 * Assets are served from open-source CDNs rather than drawn by hand, so a flag or
 * a coin logo is the real thing:
 *   - currencies → circle-flags (https://hatscripts.github.io/circle-flags)
 *   - crypto     → cryptocurrency-icons (atomiclabs, via jsDelivr)
 *
 * Both are plain <img> requests, so they need no CSP change here (the deployment
 * sets no Content-Security-Policy) — but note the request URL carries the
 * instrument, so the CDN learns which markets a visitor is looking at. That is the
 * trade accepted for using these libraries; a vendored copy under /public would
 * remove it entirely.
 *
 * EVERY icon degrades: an unknown code, a blocked network or a 404 falls back to
 * a neutral disc (currency code) or a lettered glyph, so a row is never blank.
 */

const FLAG_CDN = 'https://hatscripts.github.io/circle-flags/flags';
const CRYPTO_CDN = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color';

/**
 * Currency → the COUNTRY flag that represents it.
 *
 * circle-flags is keyed by ISO 3166-1 alpha-2 COUNTRY codes, not currencies, so
 * there is no `usd.svg` — asking for one is a 404 and the row falls back to a
 * lettered disc. EUR has no single country and uses the European Union flag.
 */
const CURRENCY_COUNTRY: Readonly<Record<string, string>> = {
  USD: 'us',
  EUR: 'eu',
  GBP: 'gb',
  JPY: 'jp',
  AUD: 'au',
  CAD: 'ca',
  CHF: 'ch',
  NZD: 'nz',
  MXN: 'mx',
  PLN: 'pl',
  SEK: 'se',
  NOK: 'no',
  DKK: 'dk',
  CZK: 'cz',
  HUF: 'hu',
  TRY: 'tr',
  ZAR: 'za',
  SGD: 'sg',
  HKD: 'hk',
  CNH: 'cn',
  INR: 'in',
};

export interface FlagIconProps {
  /** ISO-4217 code, e.g. `USD`. */
  code: string;
  size?: number;
  className?: string;
}

function FallbackDisc({ label, size, className }: { label: string; size: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-base-700/60 text-[0.6rem] font-semibold text-muted',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {label.slice(0, 3)}
    </span>
  );
}

/** One circular country flag, from the circle-flags CDN. */
export function FlagIcon({ code, size = 28, className }: FlagIconProps) {
  const upper = (code ?? '').trim().toUpperCase();
  const country = CURRENCY_COUNTRY[upper];
  const [failed, setFailed] = React.useState(false);

  if (!country || failed) {
    return <FallbackDisc label={upper || '?'} size={size} className={className} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${FLAG_CDN}/${country}.svg`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-full bg-base-800 object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}

export interface CryptoIconProps {
  /** Base symbol, e.g. `BTC`. */
  symbol: string;
  size?: number;
  className?: string;
}

/** One crypto coin logo, from the cryptocurrency-icons CDN. */
export function CryptoIcon({ symbol, size = 28, className }: CryptoIconProps) {
  const lower = (symbol ?? '').trim().toLowerCase();
  const [failed, setFailed] = React.useState(false);

  if (!/^[a-z0-9]{2,10}$/.test(lower) || failed) {
    return <FallbackDisc label={(symbol ?? '?').toUpperCase()} size={size} className={className} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${CRYPTO_CDN}/${lower}.svg`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-full bg-base-800 object-contain p-0.5', className)}
      style={{ width: size, height: size }}
    />
  );
}

export default FlagIcon;
