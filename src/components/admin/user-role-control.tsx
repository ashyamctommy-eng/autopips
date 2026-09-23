'use client';

import * as React from 'react';
import { ShieldAlert, UserCog } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/use-toast';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import type { AdminUserRowView, StaffRole } from '@/components/admin/types';

export interface UserRoleControlProps {
  user: AdminUserRowView;
  /** `PATCH /api/v1/admin/users/:id` is ADMIN-only. */
  canChangeRole: boolean;
  /** The signed-in admin's own row — flagged so a self-demotion is deliberate. */
  isSelf: boolean;
  /** Called after a successful change so the list can re-read the row. */
  onChanged: () => void;
}

const ROLE_LABELS: Record<StaffRole, string> = {
  CLIENT: 'Client',
  ADMIN: 'Administrator',
  TRADING_MANAGER: 'Trading manager',
};

const ROLE_BLURB: Record<StaffRole, string> = {
  CLIENT: 'Client — trades with their own capital. No back-office access.',
  TRADING_MANAGER: 'Trading manager — read-only back office: AUM, users, KYC queue, payouts queue, brokers.',
  ADMIN: 'Administrator — full control, including KYC decisions, payouts, plans, brokers and the audit log.',
};

/**
 * Role selector for one user.
 *
 * The change is confirmed before it is sent, and the confirmation says what the
 * role can actually do. Demoting an ADMIN is refused by the service when it would
 * leave the platform with no administrator — that refusal is a 409 whose message
 * is shown verbatim, because the reason matters more than a generic error.
 */
export function UserRoleControl({
  user,
  canChangeRole,
  isSelf,
  onChanged,
}: UserRoleControlProps) {
  const [pendingRole, setPendingRole] = React.useState<StaffRole | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!pendingRole) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminRequest<{ user: AdminUserRowView; changedFields: string[] }>(
        `/api/v1/admin/users/${encodeURIComponent(user.id)}`,
        { method: 'PATCH', body: { role: pendingRole } },
      );
      toast({
        variant: 'success',
        title: `Role updated to ${ROLE_LABELS[pendingRole]}`,
        description:
          `${user.email} · the change is audited as ADMIN_USER_ROLE_CHANGED. ` +
          'An already-issued access token keeps the previous role until it refreshes.',
      });
      setPendingRole(null);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  if (!canChangeRole) {
    return (
      <span className="text-sm text-muted" title="Changing a role is ADMIN-only">
        {ROLE_LABELS[user.role]}
      </span>
    );
  }

  const demotingAdmin = user.role === 'ADMIN' && pendingRole !== 'ADMIN';

  return (
    <>
      <Select
        value={user.role}
        onValueChange={(value) => {
          const next = value as StaffRole;
          if (next === user.role) return;
          setError(null);
          setPendingRole(next);
        }}
      >
        <SelectTrigger className="h-8 w-[11rem]" aria-label={`Role for ${user.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ROLE_LABELS) as StaffRole[]).map((role) => (
            <SelectItem key={role} value={role}>
              {ROLE_LABELS[role]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Dialog
        open={pendingRole !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPendingRole(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCog aria-hidden className="size-4 text-brand-400" />
              Change role for {user.fullName}
            </DialogTitle>
            <DialogDescription>
              {user.email} · {user.country}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <p className="text-base-100">
              {ROLE_LABELS[user.role]} → <span className="font-medium">{pendingRole ? ROLE_LABELS[pendingRole] : ''}</span>
            </p>
            {pendingRole ? <p className="text-xs leading-relaxed text-muted">{ROLE_BLURB[pendingRole]}</p> : null}

            {demotingAdmin ? (
              <Alert variant="warn">
                <AlertTitle>The last ADMIN cannot be demoted</AlertTitle>
                <AlertDescription>
                  If {user.fullName} is the only administrator, the API refuses this change with a
                  409: nobody would be left to approve KYC, settle withdrawals or manage brokers,
                  and the platform could not be recovered from inside the app. Promote another user
                  to ADMIN first.
                  {isSelf
                    ? ' You are changing your own role — if you are the last admin this will be refused.'
                    : ''}
                </AlertDescription>
              </Alert>
            ) : null}

            {isSelf ? (
              <Alert variant="info" icon={ShieldAlert}>
                <AlertTitle>This is your own account</AlertTitle>
                <AlertDescription>
                  Your new role takes effect when your current access token refreshes, and it cannot
                  be undone from this screen if you drop your own back-office access.
                </AlertDescription>
              </Alert>
            ) : null}

            {error ? (
              <Alert variant="danger">
                <AlertTitle>Role not changed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingRole(null);
                setError(null);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Applying…' : 'Change role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default UserRoleControl;
