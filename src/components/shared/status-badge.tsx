import * as React from 'react';
import { Circle, CircleAlert, CircleCheck, Clock, type LucideIcon } from 'lucide-react';

import { KYC_STATUS_META, PAYMENT_STATUS_META } from '@/lib/contracts';
import { cn } from '@/lib/utils';
import { Badge, type BadgeProps } from '@/components/ui/badge';

type BadgeVariant = NonNullable<BadgeProps['variant']>;
type StatusTone = 'pending' | 'ok' | 'bad' | 'neutral';

/**
 * Tone → Badge variant. Tones come straight from the `*_STATUS_META` maps in
 * `src/lib/contracts.ts`; only the presentation mapping lives here.
 */
export const STATUS_TONE_VARIANT: Record<StatusTone, BadgeVariant> = {
  pending: 'warn',
  ok: 'success',
  bad: 'danger',
  neutral: 'outline',
};

const TONE_ICON: Record<StatusTone, LucideIcon> = {
  pending: Clock,
  ok: CircleCheck,
  bad: CircleAlert,
  neutral: Circle,
};

/** Investment lifecycle labels (no map exists in contracts.ts — enum is DTO-only). */
const INVESTMENT_STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  PENDING: { label: 'Pending', tone: 'pending' },
  ACTIVE: { label: 'Active', tone: 'ok' },
  PAUSED: { label: 'Paused', tone: 'pending' },
  MATURED: { label: 'Matured', tone: 'ok' },
  CANCELLED: { label: 'Cancelled', tone: 'bad' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

/** Broker / MetaApi connection states as reported by the bridge. */
const BROKER_STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  CONNECTED: { label: 'Connected', tone: 'ok' },
  DEPLOYED: { label: 'Deployed', tone: 'ok' },
  CONNECTING: { label: 'Connecting', tone: 'pending' },
  DISCONNECTED: { label: 'Disconnected', tone: 'bad' },
  ERROR: { label: 'Error', tone: 'bad' },
  UNDEPLOYED: { label: 'Undeployed', tone: 'neutral' },
};

export type StatusKind = 'auto' | 'kyc' | 'payment' | 'investment' | 'broker';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  blurb?: string;
}

/**
 * Resolve a raw status string to `{ label, tone }`.
 * Unknown strings are never guessed — they fall back to a neutral outline.
 */
export function resolveStatusMeta(status: string, kind: StatusKind = 'auto'): StatusMeta {
  const key = status.toUpperCase();
  const lookup = (): StatusMeta | undefined => {
    switch (kind) {
      case 'kyc':
        return KYC_STATUS_META[key];
      case 'payment':
        return PAYMENT_STATUS_META[key];
      case 'investment':
        return INVESTMENT_STATUS_META[key];
      case 'broker':
        return BROKER_STATUS_META[key];
      case 'auto':
        return (
          KYC_STATUS_META[key] ??
          PAYMENT_STATUS_META[key] ??
          INVESTMENT_STATUS_META[key] ??
          BROKER_STATUS_META[key]
        );
    }
  };
  const meta = lookup();
  if (!meta) {
    return { label: status.replace(/_/g, ' ').toLowerCase(), tone: 'neutral' };
  }
  return { label: meta.label, tone: meta.tone, blurb: 'blurb' in meta ? meta.blurb : undefined };
}

export interface StatusBadgeProps {
  /** Raw enum value, e.g. `'UNDER_REVIEW'`, `'CONFIRMED'`, `'DEPLOYED'`. */
  status: string;
  /** Which enum the string belongs to. `auto` (default) tries every map. */
  kind?: StatusKind;
  /** Show a tone-appropriate leading icon. */
  showIcon?: boolean;
  className?: string;
}

/**
 * The single status renderer for the platform. Uses the contracts maps, so a
 * new enum member needs no UI change — a new *tone* does.
 */
export function StatusBadge({ status, kind = 'auto', showIcon = false, className }: StatusBadgeProps) {
  const meta = resolveStatusMeta(status, kind);
  const Icon = TONE_ICON[meta.tone];
  return (
    <Badge
      variant={STATUS_TONE_VARIANT[meta.tone]}
      className={cn('capitalize', className)}
      title={meta.blurb}
    >
      {showIcon ? <Icon aria-hidden /> : null}
      {meta.label}
    </Badge>
  );
}
