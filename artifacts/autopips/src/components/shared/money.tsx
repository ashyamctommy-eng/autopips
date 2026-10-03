import * as React from 'react';

import { abbreviateUsd, cn } from '@/lib/utils';
import { D, formatPercent, formatUsd, type Numeric } from '@/lib/money';

export type ValueTone = 'auto' | 'neutral' | 'profit' | 'loss' | 'warn';

const TONE_TEXT: Record<Exclude<ValueTone, 'auto'>, string> = {
  neutral: '',
  profit: 'text-profit-400',
  loss: 'text-loss-400',
  warn: 'text-warn-400',
};

function isRenderable(value: Numeric | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return true;
}

/** `'profit' | 'loss' | 'neutral'` derived from the sign of the value. */
export function signTone(value: Numeric): Exclude<ValueTone, 'auto'> {
  const decimal = D(value);
  if (decimal.greaterThan(0)) return 'profit';
  if (decimal.lessThan(0)) return 'loss';
  return 'neutral';
}

function resolveTone(value: Numeric, tone: ValueTone): string {
  if (tone === 'neutral') return TONE_TEXT.neutral;
  if (tone === 'auto') return TONE_TEXT[signTone(value)];
  return TONE_TEXT[tone];
}

/** The em dash shown for a value the API has not provided yet. */
export const MONEY_PLACEHOLDER = '—';

export interface FormatUsdDisplayOptions {
  /** Prefix a `+` for positive values. */
  sign?: boolean;
  /** Abbreviate large figures (`$1.2K`) — headline widgets only. */
  compact?: boolean;
  /** Render the `$` glyph. Defaults to true. */
  currency?: boolean;
}

/**
 * Canonical USD text formatter for the UI, on top of `src/lib/money.ts`.
 * Components and non-JSX helpers (CSV export, chart tooltips) share it, so the
 * sign/currency handling never diverges.
 */
export function formatUsdDisplay(
  value: Numeric | null | undefined,
  { sign = false, compact = false, currency = true }: FormatUsdDisplayOptions = {},
): string {
  if (!isRenderable(value)) return MONEY_PLACEHOLDER;
  const decimal = D(value as Numeric);
  const negative = decimal.lessThan(0);
  const absolute = decimal.abs();
  const body = compact ? abbreviateUsd(absolute.toNumber()) : formatUsd(absolute);
  const prefix = negative ? '-' : sign && decimal.greaterThan(0) ? '+' : '';
  return `${prefix}${currency ? '$' : ''}${body}`;
}

export interface UsdProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: Numeric | null | undefined;
  /** Show a leading `+` on gains. */
  sign?: boolean;
  /** Abbreviate (AUM headline tiles). */
  compact?: boolean;
  /** Render the `$` glyph. Defaults to true. */
  currency?: boolean;
  /**
   * `auto` (default) colours by sign: gains emerald, losses rose.
   * Pass `neutral` for balances/equity, which are not a P/L statement.
   */
  tone?: ValueTone;
}

/** USD amount. Tabular figures so columns never jitter as values update. */
export function Usd({
  value,
  sign = false,
  compact = false,
  currency = true,
  tone = 'auto',
  className,
  ...props
}: UsdProps) {
  const text = formatUsdDisplay(value, { sign, compact, currency });
  const renderable = isRenderable(value);
  return (
    <span
      className={cn(
        'tabular-nums whitespace-nowrap',
        renderable ? resolveTone(value as Numeric, tone) : 'text-muted',
        className,
      )}
      {...props}
    >
      {text}
    </span>
  );
}

export interface SignedUsdProps extends Omit<UsdProps, 'sign' | 'tone'> {
  tone?: ValueTone;
}

/** A signed P/L figure: always shows `+`/`-` and is coloured by sign. */
export function SignedUsd({ tone = 'auto', ...props }: SignedUsdProps) {
  return <Usd sign tone={tone} {...props} />;
}

export interface PctProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: Numeric | null | undefined;
  /** Decimal places. Defaults to 2. */
  dp?: number;
  /** Show a leading `+` on positive values (returns). */
  sign?: boolean;
  tone?: ValueTone;
}

/** Percentage figure. `tone="auto"` colours by sign. */
export function Pct({ value, dp = 2, sign = false, tone = 'auto', className, ...props }: PctProps) {
  if (!isRenderable(value)) {
    return (
      <span className={cn('tabular-nums text-muted', className)} {...props}>
        {MONEY_PLACEHOLDER}
      </span>
    );
  }
  const decimal = D(value as Numeric);
  const negative = decimal.lessThan(0);
  const body = formatPercent(decimal.abs(), dp);
  const prefix = negative ? '-' : sign && decimal.greaterThan(0) ? '+' : '';
  return (
    <span
      className={cn('tabular-nums whitespace-nowrap', resolveTone(decimal, tone), className)}
      {...props}
    >
      {prefix}
      {body}
    </span>
  );
}
