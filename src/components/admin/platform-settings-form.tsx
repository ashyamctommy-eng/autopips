'use client';

import * as React from 'react';
import { RotateCcw, Save } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/use-toast';
import type { AdminSettingView } from '@/server/modules/settings/settings.service';

/**
 * Platform settings editor (client component).
 *
 * One row per editable key. A saved value OVERRIDES the service environment
 * variable of the same meaning; "Revert" deletes the row and puts the env value
 * back, so nothing here can lock the platform out of its own configuration.
 *
 * Details that matter:
 *   • the "Save" button is disabled while the field is empty — an empty submit
 *     means "clear this key" on the API, and a mis-click must not silently drop
 *     a live payment credential;
 *   • clearing is therefore an explicit, two-step action;
 *   • every row shows WHERE its current value comes from, because "it works
 *     locally but not in production" is almost always this question;
 *   • the server returns the refreshed list after each write, so the badges,
 *     masks and timestamps are the server's truth, not an optimistic guess.
 *
 * A secret's plaintext is never sent to the browser: the masked value is display
 * only, and the input starts empty ("leave blank to keep").
 */

interface PlatformSettingsFormProps {
  initial: AdminSettingView[];
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : fallback;
}

function SourceBadge({ source }: { source: AdminSettingView['source'] }) {
  if (source === 'console') return <Badge variant="success">Set here</Badge>;
  if (source === 'environment') return <Badge variant="outline">Service variable</Badge>;
  return <Badge variant="warn">Not set</Badge>;
}

export function PlatformSettingsForm({ initial }: PlatformSettingsFormProps) {
  const [rows, setRows] = React.useState<AdminSettingView[]>(initial);

  const replaceAll = React.useCallback((next: AdminSettingView[]) => {
    if (Array.isArray(next) && next.length > 0) setRows(next);
  }, []);

  return (
    <div className="flex flex-col">
      {rows.map((row, index) => (
        <React.Fragment key={row.key}>
          {index > 0 ? <Separator /> : null}
          <SettingRow setting={row} onUpdated={replaceAll} />
        </React.Fragment>
      ))}
    </div>
  );
}

function SettingRow({
  setting,
  onUpdated,
}: {
  setting: AdminSettingView;
  onUpdated: (next: AdminSettingView[]) => void;
}) {
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirmingClear, setConfirmingClear] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fieldId = `setting-${setting.key.replace(/\./g, '-')}`;

  const write = React.useCallback(
    async (next: string | null, successTitle: string) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch('/api/v1/admin/settings', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ key: setting.key, value: next }),
        });
        const body: unknown = await response.json();
        const ok =
          typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;

        if (!response.ok || !ok) {
          const message = errorMessage(body, `The setting was not saved (HTTP ${response.status}).`);
          setError(message);
          toast({ title: 'Setting not saved', description: message, variant: 'danger' });
          return;
        }

        const data = (body as { data?: { settings?: AdminSettingView[] } }).data;
        if (data?.settings) onUpdated(data.settings);

        setValue('');
        setConfirmingClear(false);
        toast({
          title: successTitle,
          description: setting.secret
            ? `${setting.label} updated. The value is stored encrypted and will not be shown again.`
            : `${setting.label} updated.`,
          variant: 'success',
        });
      } catch {
        const message = 'The setting was not saved. Check your connection and try again.';
        setError(message);
        toast({ title: 'Setting not saved', description: message, variant: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [onUpdated, setting.key, setting.label, setting.secret],
  );

  return (
    <div className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={fieldId} className="text-sm font-medium text-base-100">
          {setting.label}
        </Label>
        <SourceBadge source={setting.source} />
        {setting.updatedAt ? (
          <span className="text-xs text-muted">
            last changed {new Date(setting.updatedAt).toLocaleString('en-GB')}
            {setting.updatedBy ? ` by ${setting.updatedBy}` : ''}
          </span>
        ) : null}
      </div>

      <p className="max-w-3xl text-xs leading-relaxed text-muted">{setting.description}</p>

      {setting.display ? (
        <p className="font-mono text-xs text-base-100">
          current: <span className="break-all">{setting.display}</span>
        </p>
      ) : (
        <p className="text-xs text-warn-400">
          No value from either source — payments that depend on this key will fail until it is set.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-64 flex-1 gap-2">
          <Label htmlFor={fieldId} className="sr-only">
            {setting.label}
          </Label>
          <Input
            id={fieldId}
            name={setting.key}
            type={setting.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              setting.display && setting.secret
                ? 'Leave blank to keep the current value'
                : setting.inputHint
            }
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </div>

        <Button
          type="button"
          onClick={() => write(value.trim(), `${setting.label} saved`)}
          disabled={busy || value.trim().length === 0}
        >
          {busy ? <Spinner aria-hidden /> : <Save aria-hidden />}
          Save
        </Button>

        {setting.source === 'console' ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!confirmingClear) {
                setConfirmingClear(true);
                return;
              }
              void write(null, `${setting.label} reverted`);
            }}
            onBlur={() => setConfirmingClear(false)}
            disabled={busy}
          >
            <RotateCcw aria-hidden />
            {confirmingClear ? 'Confirm revert' : 'Revert to service variable'}
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-loss-400">{error}</p> : null}
    </div>
  );
}
