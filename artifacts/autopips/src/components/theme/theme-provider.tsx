'use client';

import * as React from 'react';

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  isThemePreference,
  persistTheme,
  readStoredTheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

interface ThemeContextValue {
  /** The visitor's stored choice, including `system`. */
  theme: ThemePreference;
  /** What that choice resolves to right now — what is actually on screen. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Server-render default. Dark unless a surface explicitly says otherwise. */
  defaultTheme?: ThemePreference;
}

/**
 * THEME PROVIDER
 *
 * Thin on purpose: the palette itself is CSS (`html[data-theme]` in
 * globals.css), and the pre-paint script in `layout.tsx` has already stamped the
 * attribute before this component mounts. All this does is:
 *
 *   1. expose the current choice / resolved value to the toggle, and
 *   2. keep `<html>` in sync when the visitor picks a theme or the OS flips
 *      while the choice is `system`.
 *
 * It writes no colour itself, so there is no second source of truth.
 */
export function ThemeProvider({ children, defaultTheme = DEFAULT_THEME_PREFERENCE }: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<ThemePreference>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(
    defaultTheme === 'system' ? 'dark' : defaultTheme,
  );

  React.useEffect(() => {
    // The blocking script read localStorage before paint; mirror it into state
    // (and re-apply, so the provider is correct even if the script never ran).
    const stored = readStoredTheme();
    setThemeState(stored);
    setResolvedTheme(applyThemeToDocument(stored));
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onOsChange = () => {
      const stored = readStoredTheme();
      setThemeState(stored);
      setResolvedTheme(applyThemeToDocument(stored));
    };
    media.addEventListener('change', onOsChange);
    return () => media.removeEventListener('change', onOsChange);
  }, []);

  const setTheme = React.useCallback((next: ThemePreference) => {
    if (!isThemePreference(next)) return;
    setThemeState(next);
    persistTheme(next);
    setResolvedTheme(applyThemeToDocument(next));
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside a <ThemeProvider>.');
  }
  return context;
}

export { THEME_STORAGE_KEY, resolveTheme };
export type { ResolvedTheme, ThemePreference };
