import * as React from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';

import { RISK_LEVELS, type RiskLevel } from '@/lib/contracts';
import { cn } from '@/lib/utils';
import { Badge, type BadgeProps } from '@/components/ui/badge';

/**
 * Risk band → colour + icon.
 * LOW = emerald, MEDIUM = amber, HIGH = rose. Unknown values stay neutral —
 * the platform never infers a risk band it was not given.
 */
const RISK_META: Record<
  RiskLevel,
  { label: string; variant: NonNullable<BadgeProps['variant']>; icon: LucideIcon; iconClass: string }
> = {
  LOW: { label: 'Low risk', variant: 'success', icon: ShieldCheck, iconClass: 'text-profit-400' },
  MEDIUM: { label: 'Medium risk', variant: 'warn', icon: ShieldAlert, iconClass: 'text-warn-400' },
  HIGH: { label: 'High risk', variant: 'danger', icon: ShieldX, iconClass: 'text-loss-400' },
};

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value.toUpperCase());
}

export interface RiskBadgeProps {
  /** `'LOW' | 'MEDIUM' | 'HIGH'` (case-insensitive). Anything else → neutral. */
  level: string;
  showIcon?: boolean;
  className?: string;
}

export function RiskBadge({ level, showIcon = true, className }: RiskBadgeProps) {
  const key = level.toUpperCase();
  const meta = isRiskLevel(key) ? RISK_META[key] : null;

  if (!meta) {
    return (
      <Badge variant="outline" className={className} title="Unrecognised risk band">
        {level}
      </Badge>
    );
  }

  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      {showIcon ? <Icon aria-hidden className={cn(meta.iconClass)} /> : null}
      {meta.label}
    </Badge>
  );
}
