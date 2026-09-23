import * as React from 'react';

import { cn } from '@/lib/utils';

/** Stable id for the logo gradient — one definition, reused by every instance. */
const GRADIENT_ID = 'autopipsz-brand-gradient';

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
 * The Autopipsz wordmark. Pure inline SVG + text, no external asset, so it is
 * safe in any bundle and renders identically on the server.
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
        aria-label="Autopipsz"
        className={cn('shrink-0', SIZE_GLYPH[size])}
      >
        <defs>
          <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#10B981" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="#10141C" stroke="rgba(148,163,184,0.14)" />
        {/* Three ascending bars: the pip ladder. */}
        <rect x="8" y="18" width="4" height="7" rx="1.5" fill="rgba(148,163,184,0.45)" />
        <rect x="14" y="13" width="4" height="12" rx="1.5" fill="rgba(34,211,238,0.75)" />
        <rect x="20" y="7" width="4" height="18" rx="1.5" fill={`url(#${GRADIENT_ID})`} />
      </svg>
      {showWordmark ? (
        <span
          className={cn(
            'font-semibold leading-none tracking-tight text-base-100',
            SIZE_TEXT[size],
            wordmarkClassName,
          )}
        >
          Auto<span className="text-brand-400">pips</span>z
        </span>
      ) : null}
    </span>
  );
}
