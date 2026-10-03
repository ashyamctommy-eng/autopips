import * as React from 'react';
import { Info, ShieldAlert } from 'lucide-react';

import {
  DISCLAIMER_SHORT,
  TARGET_RETURN_DISCLAIMER,
  TARGET_RETURN_LABEL,
} from '@/lib/contracts';
import { formatPercent, type Numeric } from '@/lib/money';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------------- *
 * COMPLIANCE COMPONENT — READ BEFORE EDITING (business directive #2).
 *
 * Every target / expected / projected return figure on this platform MUST be
 * rendered together with {@link TARGET_RETURN_LABEL}. That is the whole reason
 * this file exists.
 *
 *   ✗ NEVER do this:   <span>{formatPercent(plan.targetReturnMin)}</span>
 *   ✓ ALWAYS do this:  <TargetRange min={plan.targetReturnMin} max={plan.targetReturnMax} />
 *
 * `TargetRange` is deliberately the only sanctioned renderer for a target
 * range: it has no prop that can suppress the label, so a page team cannot
 * accidentally ship an unqualified figure. If you need a different layout,
 * add a `note` variant here — do not bypass it.
 * ------------------------------------------------------------------------- */

export type DisclaimerVariant = 'inline' | 'banner' | 'footnote';

export interface NonGuaranteedNoteProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `inline` (default) sits next to a figure, `banner` is a full alert block. */
  variant?: DisclaimerVariant;
}

/**
 * The non-guarantee caveat on its own.
 *
 * Use it for section-level or page-level statements. For a specific figure use
 * {@link TargetRange}, which cannot be rendered without it.
 */
export function NonGuaranteedNote({
  variant = 'inline',
  className,
  ...props
}: NonGuaranteedNoteProps) {
  if (variant === 'banner') {
    return (
      <div
        role="note"
        className={cn(
          'flex items-start gap-3 rounded-lg border border-warn/30 bg-warn/[0.07] p-4 text-sm text-base-100',
          className,
        )}
        {...props}
      >
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn-400" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{TARGET_RETURN_LABEL}</span>
          <span className="text-sm leading-relaxed text-muted">{TARGET_RETURN_DISCLAIMER}</span>
        </div>
      </div>
    );
  }

  if (variant === 'footnote') {
    return (
      <p
        className={cn('text-xs italic leading-relaxed text-muted', className)}
        title={TARGET_RETURN_DISCLAIMER}
        {...props}
      >
        {TARGET_RETURN_LABEL}. {DISCLAIMER_SHORT} — strategy objectives, not a promise of future
        performance.
      </p>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-muted', className)}
      title={TARGET_RETURN_DISCLAIMER}
      {...props}
    >
      <Info aria-hidden className="size-3 shrink-0" />
      {TARGET_RETURN_LABEL}
    </span>
  );
}

export interface TargetRangeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Lower bound of the objective, in percent units (e.g. `8` → "8.00%"). */
  min: Numeric | null | undefined;
  /** Upper bound of the objective, in percent units. */
  max: Numeric | null | undefined;
  /** Which caveat style to render alongside the figure. Never removable. */
  note?: DisclaimerVariant;
  /** Applied to the figure itself. */
  valueClassName?: string;
  /** Drop the surrounding flex wrapper (for tight table cells). */
  asText?: boolean;
}

function renderable(value: Numeric | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return true;
}

/**
 * THE ONLY sanctioned way to render a target/indicative return range.
 *
 * Always emits {@link TARGET_RETURN_LABEL} (or the full
 * {@link TARGET_RETURN_DISCLAIMER} for `note="banner"`) next to the figure.
 */
export function TargetRange({
  min,
  max,
  note = 'inline',
  className,
  valueClassName,
  asText = false,
  ...props
}: TargetRangeProps) {
  const hasMin = renderable(min);
  const hasMax = renderable(max);
  const caveat =
    note === 'banner' ? (
      <NonGuaranteedNote variant="banner" className={asText ? undefined : 'mt-2 w-full'} />
    ) : (
      <NonGuaranteedNote variant={note} />
    );

  // Nothing to qualify — render the caveat alone rather than a fake figure.
  if (!hasMin && !hasMax) {
    return <span className={cn(asText ? 'inline' : 'inline-flex flex-col', className)} {...props}>{caveat}</span>;
  }

  const lower = hasMin ? formatPercent(min as Numeric) : null;
  const upper = hasMax ? formatPercent(max as Numeric) : null;
  const sameFigure = lower !== null && upper !== null && lower === upper;
  const figure = sameFigure
    ? lower
    : `${lower ?? '—'} – ${upper ?? '—'}`;

  if (asText) {
    return (
      <span className={className} {...props}>
        <span className={cn('tabular-nums', valueClassName)}>{figure}</span>{' '}
        <NonGuaranteedNote variant={note === 'banner' ? 'inline' : note} />
      </span>
    );
  }

  return (
    <span className={cn('inline-flex flex-col gap-0.5', className)} {...props}>
      <span className={cn('tabular-nums text-base-100', valueClassName)}>{figure}</span>
      {caveat}
    </span>
  );
}
