'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ANY = 'ANY';

export interface LogFiltersProps {
  /** Every current `AUDIT` action constant, straight from the audit module. */
  actions: string[];
  /** `/admin/logs` (or the alias path this filter is rendered under). */
  basePath: string;
  action: string | null;
  userId: string | null;
}

/**
 * Audit-log filters.
 *
 * Both filters are part of the URL, so a filtered view is a shareable,
 * reproducible link — which is the point of an audit trail. The dropdown is
 * populated from the platform's real `AUDIT` constants, so it can never offer an
 * action that no code writes.
 */
export function LogFilters({ actions, basePath, action, userId }: LogFiltersProps) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<string>(action ?? ANY);
  const [user, setUser] = React.useState<string>(userId ?? '');

  const push = (nextAction: string, nextUser: string) => {
    const params = new URLSearchParams();
    if (nextAction !== ANY) params.set('action', nextAction);
    const trimmedUser = nextUser.trim();
    if (trimmedUser !== '') params.set('userId', trimmedUser);
    const query = params.toString();
    router.push(query === '' ? basePath : `${basePath}?${query}`);
  };

  const dirty = (action ?? ANY) !== selected || (userId ?? '') !== user.trim();

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-line bg-base-850/60 p-4 lg:flex-row lg:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        push(selected, user);
      }}
    >
      <div className="flex w-full flex-col gap-1.5 lg:w-80">
        <Label htmlFor="log-action">Action</Label>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger id="log-action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ANY}>Every action</SelectItem>
            {actions.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="log-user">Actor user id</Label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            id="log-user"
            value={user}
            onChange={(event) => setUser(event.target.value)}
            placeholder="Exact user id (cuid)"
            className="pl-9 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={!dirty}>
          Apply filters
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSelected(ANY);
            setUser('');
            router.push(basePath);
          }}
        >
          <X aria-hidden />
          Clear
        </Button>
      </div>
    </form>
  );
}

export default LogFilters;
