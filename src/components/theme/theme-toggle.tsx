'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/components/theme/theme-provider';
import type { ThemePreference } from '@/lib/theme';

interface ThemeOption {
  value: ThemePreference;
  label: string;
  description: string;
  Icon: typeof Sun;
}

/** Order matches the visual weight of the choice: light, dark, then follow the OS. */
const OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', description: 'Executive surface', Icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Trading terminal', Icon: Moon },
  { value: 'system', label: 'System', description: 'Match device', Icon: Monitor },
];

const ICON_FOR: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export interface ThemeToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render the trigger as icon + label instead of a compact icon button. */
  showLabel?: boolean;
}

/**
 * THEME TOGGLE
 *
 * Self-contained: reads and writes the ThemeProvider context, renders its own
 * menu, and needs no props to work. Drop `<ThemeToggle />` into any client
 * surface that sits under `<AppProviders>`.
 *
 * Note for the shell: it belongs in the topbar's `actions` slot (see the
 * hand-over note in the report) — this component deliberately does not mount
 * itself anywhere.
 */
export function ThemeToggle({ className, showLabel = false, ...props }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const TriggerIcon = ICON_FOR[theme];
  const current = OPTIONS.find((option) => option.value === theme) ?? OPTIONS[1]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={showLabel ? 'sm' : 'icon'}
          aria-label={`Theme: ${current.label} (currently ${resolvedTheme}). Change theme.`}
          title={`Theme: ${current.label}`}
          className={cn('text-muted', showLabel ? 'gap-2' : 'size-9', className)}
          {...props}
        >
          <TriggerIcon aria-hidden />
          {showLabel ? <span className="text-sm text-base-100">{current.label}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)}>
          {OPTIONS.map((option) => {
            const OptionIcon = option.Icon;
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value} className="items-start gap-2.5">
                <OptionIcon aria-hidden className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-base-100">{option.label}</span>
                  <span className="text-xs text-muted">{option.description}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
