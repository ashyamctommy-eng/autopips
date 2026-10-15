import * as React from 'react';

import { cn } from '@/lib/utils';

/** Stable id for the logo gradient — one definition, reused by every instance.
 *  Must stay unique on the page: two different ids would double the paint. */
const GRADIENT_ID = 'autopips-markets-mark-gradient';

const SIZE_GLYPH: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
  xl: 'size-14',
};

const SIZE_TEXT: Record<NonNullable<BrandMarkProps['size']>, string> = {
  sm: 'text-sm',
  md: 'text-[1rem]',
  lg: 'text-lg',
  xl: 'text-2xl',
};

export interface BrandMarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the wordmark and render the glyph alone (collapsed sidebar). */
  showWordmark?: boolean;
  /** Wordmark colour override — the glyph keeps its brand gradient. */
  wordmarkClassName?: string;
}

/**
 * The Autopips Markets mark — the monogram A.
 *
 * A deep-green badge holding a white capital A with a gold crossbar. The full
 * supplied icon — bull head, horned A, candlestick cluster, rising arrow — was
 * tried here first and failed the only test that matters: at the 24px the header
 * actually renders it at, the horns radiating from the apex fought the A's legs
 * and the glyph read as an X, and the candle cluster turned to mud below ~40px.
 *
 * So the mark is reduced to what survives: one unambiguous letterform and a
 * two-tone accent. The bull-and-candles identity is carried by the supplied
 * artwork itself, which ships as the app/OG image (see `public/brand-icon.png`)
 * where it is displayed large enough to be read.
 *
 * The glyph is drawn in FIXED brand colours rather than theme tokens on purpose —
 * a logo should look the same in the dark terminal, the light theme and the
 * admin console — while the wordmark follows the active palette so it stays
 * legible on both surfaces.
 *
 * Pure inline SVG + text, no external asset, so it is safe in any bundle and
 * renders identically on the server.
 */
export function BrandMark({
  size = 'md',
  showWordmark = true,
  className,
  wordmarkClassName,
  ...props
}: BrandMarkProps) {
  return (
    <span className={cn('inline-flex items-center gap-2 select-none', className)} {...props}>
      <svg
        viewBox="0 0 32 32"
        role="img"
        aria-label="Autopips Markets"
        className={cn('shrink-0', SIZE_GLYPH[size])}
      >
        <defs>
          <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0E8A61" />
            <stop offset="100%" stopColor="#075B41" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${GRADIENT_ID})`} />

        {/* The A: two straight legs, apex at the top-centre. */}
        <path
          d="M10.6 25.4 L16 13.4 M21.4 25.4 L16 13.4"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        {/* The crossbar carries the gold — the one two-tone accent. */}
        <path
          d="M12.7 21.2 H19.3"
          fill="none"
          stroke="#D9A441"
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      </svg>
      {showWordmark ? (
        <span
          className={cn(
            'font-semibold leading-none tracking-tight text-base-100',
            SIZE_TEXT[size],
            wordmarkClassName,
          )}
        >
          Autopips <span className="text-brand-600">Markets</span>
        </span>
      ) : null}
    </span>
  );
}
