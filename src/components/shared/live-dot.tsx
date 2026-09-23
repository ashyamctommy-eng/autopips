import * as React from 'react';

import { cn } from '@/lib/utils';

export type LiveDotState = 'connected' | 'disconnected' | 'paused' | 'connecting' | 'error';

const STATE_CLASS: Record<LiveDotState, string> = {
  connected: 'bg-profit',
  connecting: 'bg-warn',
  paused: 'bg-warn',
  disconnected: 'bg-muted',
  error: 'bg-loss',
};

const STATE_LABEL: Record<LiveDotState, string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  paused: 'Paused',
  connecting: 'Connecting',
  error: 'Error',
};

const DOT_SIZE: Record<NonNullable<LiveDotProps['size']>, string> = {
  sm: 'size-1.5',
  default: 'size-2',
  lg: 'size-2.5',
};

export interface LiveDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  state?: LiveDotState;
  /**
   * Text shown after the dot. Omit for the default state word, pass `null` for
   * the bare indicator.
   */
  label?: React.ReactNode;
  size?: 'sm' | 'default' | 'lg';
  /** Override the pulsing halo. Defaults to pulsing only while connected. */
  pulse?: boolean;
}

/**
 * Connection indicator used next to "Bot status", broker status and the live
 * activity feed. The halo uses the design-system `pulse-ring` animation; only
 * a live connection pulses, so a stalled feed is visible at a glance.
 */
export function LiveDot({
  state = 'disconnected',
  label,
  size = 'default',
  pulse,
  className,
  ...props
}: LiveDotProps) {
  const shouldPulse = pulse ?? state === 'connected';
  return (
    <span className={cn('inline-flex items-center gap-2', className)} {...props}>
      <span
        role="status"
        aria-label={STATE_LABEL[state]}
        className={cn(
          'inline-block shrink-0 rounded-full',
          DOT_SIZE[size],
          STATE_CLASS[state],
          shouldPulse && 'animate-pulse-ring',
        )}
      />
      {label === null ? null : (
        <span className="text-xs text-muted">{label ?? STATE_LABEL[state]}</span>
      )}
    </span>
  );
}
