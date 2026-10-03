'use client';

import * as React from 'react';

export interface UseControllableStateParams<T> {
  /** Controlled value. When `undefined` the hook keeps its own state. */
  value?: T;
  defaultValue: T;
  onChange?: (next: T) => void;
}

/**
 * Controlled-or-uncontrolled state, so the layout components work both
 * standalone (own their collapse state) and inside AppShell (which drives them
 * from the mobile drawer).
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: UseControllableStateParams<T>): [T, (next: T) => void] {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<T>(defaultValue);
  const current = isControlled ? (value as T) : internal;

  const setValue = React.useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  return [current, setValue];
}

/** Convenience wrapper for boolean flags (sidebar collapse, drawer open…). */
export function useControllableBoolean(params: {
  value?: boolean;
  defaultValue: boolean;
  onChange?: (next: boolean) => void;
}): [boolean, () => void, (next: boolean) => void] {
  const [value, setValue] = useControllableState(params);
  const toggle = React.useCallback(() => setValue(!value), [setValue, value]);
  return [value, toggle, setValue];
}
