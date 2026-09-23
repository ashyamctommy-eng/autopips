import * as React from 'react';
import { ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export interface AdminOnlyNoticeProps {
  /** What the visitor tried to open, e.g. "the audit log". */
  feature: string;
}

/**
 * Shown to a TRADING_MANAGER on the surfaces that are ADMIN-only server-side
 * (plans, the payout decisions, KYC document access, the audit log).
 *
 * A trading manager can reach the admin shell, so these pages are rendered — but
 * the API would answer 403. Saying so beats a button that cannot work.
 */
export function AdminOnlyNotice({ feature }: AdminOnlyNoticeProps) {
  return (
    <Alert variant="warn">
      <ShieldAlert aria-hidden />
      <AlertTitle>Administrator access required</AlertTitle>
      <AlertDescription>
        Your account has the TRADING_MANAGER role, which cannot open {feature}. The API refuses this
        request for every role except ADMIN, so nothing is shown rather than a partial or
        unauthorised view. Ask an administrator if you need access.
      </AlertDescription>
    </Alert>
  );
}

export default AdminOnlyNotice;
