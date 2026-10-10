import * as React from 'react';

import { cn } from '@/lib/utils';

/** Stable id for the logo gradient — one definition, reused by every instance. */
const GRADIENT_ID = 'baltimore-capital-mark-gradient';

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
 * The Baltimore Capital mark — "the Beacon B".
 *
 * A rounded badge carries a monogram B whose two bowls read as ascending arcs
 * (growth), with a warm gold beacon at the shoulder: the capital point the
 * platform guides toward. The glyph is drawn in FIXED brand colours rather than
 * theme tokens on purpose — a logo should look the same in the dark terminal,
 * the light theme and the admin console — while the wordmark's accent follows
 * the active palette so it stays legible on both surfaces.
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
        aria-label="Baltimore Capital"
        className={cn('shrink-0', SIZE_GLYPH[size])}
      >
        <defs>
          <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4C6FFF" />
            <stop offset="100%" stopColor="#7C5CFF" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${GRADIENT_ID})`} />
        {/* Monogram B: one stem, two bowls that rise as they open. */}
        <path
          d="M12.5 9 V23"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        <path
          d="M12.5 9 H17 A3.5 3.5 0 0 1 17 16 H12.5"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12.5 16 H17.5 A3.5 3.5 0 0 1 17.5 23 H12.5"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* The beacon: capital gold, at the shoulder of the mark. */}
        <circle cx="23.5" cy="8.5" r="2.4" fill="#F0B450" />
      </svg>
      {showWordmark ? (
        <span
          className={cn(
            'font-semibold leading-none tracking-tight text-base-100',
            SIZE_TEXT[size],
            wordmarkClassName,
          )}
        >
          Baltimore <span className="text-accent-400">Capital</span>
        </span>
      ) : null}
    </span>
  );
}
