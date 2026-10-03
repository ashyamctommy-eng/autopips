'use client';

import * as React from 'react';

import {
  fallbackTokens,
  readMonospaceFamily,
  resolveTokens,
  type TokenSpec,
} from '@/lib/theme';

/**
 * THEME CHANGE SIGNAL
 *
 * Canvas/SVG libraries cannot consume CSS variables, so the chart components
 * resolve token values with `getComputedStyle` (see `resolveTokens` in
 * `@/lib/theme`). This hook gives them a re-render trigger whenever the palette
 * actually changes: `<html data-theme>` is written by the ThemeProvider (and by
 * the blocking pre-paint script), and the `.dark` class toggles with it, so a
 * MutationObserver on those two attributes covers every path — user choice,
 * `system` following an OS change, and the initial sync after hydration.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    const bump = () => setVersion((current) => current + 1);

    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', bump);

    // The pre-paint script may have resolved a different theme before React
    // mounted; bump once so the first effect pass re-reads the live values.
    bump();

    return () => {
      observer.disconnect();
      media.removeEventListener('change', bump);
    };
  }, []);

  return version;
}

/** Whether the component has mounted — the point at which the DOM is readable. */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Resolve a chart's palette from the design tokens, re-resolving on every theme
 * change.
 *
 * The FIRST render (on the server and on the client's hydration pass) returns
 * the spec's fallbacks — the dark palette — so the server HTML and the hydrated
 * SVG/JSX agree to the byte. After mount the live token values take over. That
 * keeps the chart markup hydration-safe while still following the theme; the
 * canvas chart (lightweight-charts) reads live values from its effects instead,
 * because its markup carries no colours.
 */
export function useChartTheme<T extends Record<string, TokenSpec>>(
  spec: T,
  fontFallback: string,
): { [K in keyof T]: string } & { fontFamily: string } {
  const version = useThemeVersion();
  const mounted = useMounted();

  return React.useMemo(() => {
    // `version` is the invalidation signal — `resolveTokens` reads the DOM,
    // which the linter cannot see, so reference it explicitly.
    void version;
    const tokens = mounted ? resolveTokens(spec) : fallbackTokens(spec);
    return {
      ...tokens,
      fontFamily: mounted ? readMonospaceFamily(fontFallback) : fontFallback,
    };
  }, [spec, fontFallback, version, mounted]);
}
