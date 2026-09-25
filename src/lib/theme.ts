/**
 * THEME SYSTEM — shared, framework-free primitives.
 *
 * One palette switch, driven from a single attribute on `<html>`:
 *
 *   data-theme="dark"   → the `:root` palette in globals.css (default)
 *   data-theme="light"  → the shared light palette (user choice)
 *
 * `data-theme-preference` keeps the *choice* (`dark` | `light` | `system`)
 * visible for tooling; `data-theme` always holds the resolved `dark` | `light`,
 * so CSS never has to run a media query of its own. The `.theme-admin` scope
 * still wins inside /admin because its selector is listed last in globals.css —
 * the console is always the light executive palette, whatever the visitor picked.
 *
 * This module deliberately has no `'use client'` directive: `layout.tsx` (a
 * server component) imports `THEME_INIT_SCRIPT` to inline it before paint, and
 * client components import the same constants and helpers. No top-level side
 * effects, no React import.
 */

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** localStorage key. Also read by the blocking inline script — keep them in sync. */
export const THEME_STORAGE_KEY = 'autopips-theme';

/** Dark by default: this is a trading terminal, not a document. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

/** The attribute CSS keys off. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Carries the raw preference (including `system`) alongside the resolved value. */
export const THEME_PREFERENCE_ATTRIBUTE = 'data-theme-preference';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

/** `prefers-color-scheme` — dark when unavailable, matching the shipped default. */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return prefersDark() ? 'dark' : 'light';
  return preference;
}

export function readStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  } catch {
    // Private mode / storage disabled: fall back to the default rather than throw.
    return DEFAULT_THEME_PREFERENCE;
  }
}

/**
 * Apply a preference to the document and return what it resolved to. Sets both
 * the resolved `data-theme` and the `.dark` class, so a future `dark:` variant
 * (the Tailwind config already declares `darkMode: ['class']`) keys off the
 * same switch. `color-scheme` is owned by the CSS blocks.
 */
export function applyThemeToDocument(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute(THEME_ATTRIBUTE, resolved);
    root.setAttribute(THEME_PREFERENCE_ATTRIBUTE, preference);
    root.classList.toggle('dark', resolved === 'dark');
  }
  return resolved;
}

export function persistTheme(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable — the in-memory choice still applies for this session.
  }
}

/**
 * Blocking pre-paint script, inlined as the first child of `<body>`.
 *
 * It runs before the rest of the body is parsed, so a light-theme visitor never
 * sees a dark frame. It is intentionally tiny and dependency-free: read the
 * stored preference, resolve `system` against the OS, stamp the attribute. Any
 * failure (storage disabled, malformed value) leaves the dark default in place.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=null;try{s=localStorage.getItem(k)}catch(e){}var p=(s==='light'||s==='dark'||s==='system')?s:'${DEFAULT_THEME_PREFERENCE}';var d=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=p==='system'?(d?'dark':'light'):p;var h=document.documentElement;h.setAttribute('${THEME_ATTRIBUTE}',r);h.setAttribute('${THEME_PREFERENCE_ATTRIBUTE}',p);h.classList.toggle('dark',r==='dark')}catch(e){}})();`;

/* ──────────────────────────────────────────────────────────────────────────
 * Canvas / SVG colour resolution.
 *
 * lightweight-charts and recharts take literal colour strings, so they cannot
 * consume Tailwind classes. These helpers read the SAME tokens the rest of the
 * UI uses, and the chart components re-read them when the theme attribute
 * changes (see `useThemeVersion`).
 * ────────────────────────────────────────────────────────────────────────── */

/** A token plus the alpha a specific chart element wants from it. */
export interface TokenSpec {
  /** CSS custom property name, e.g. `--c-profit-500`. */
  token: string;
  /** 0–1; only applied to `r g b` triple tokens. */
  alpha?: number;
  /** Server-render / first-paint value, read before the DOM is available. */
  fallback: string;
}

/** Computed value of a custom property on `<html>`, or null outside the browser. */
export function readCssVariable(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : null;
}

const TRIPLE = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/;

/**
 * Resolve a palette token to a concrete colour string.
 *
 * `--c-*` tokens are stored as `r g b` triples (so Tailwind opacity modifiers
 * keep working), which lets a chart ask for an alpha; `--chart-*` tokens are
 * already complete colour strings and pass through untouched.
 */
export function readTokenColor(token: string, alpha = 1, fallback = 'transparent'): string {
  const raw = readCssVariable(token);
  if (!raw) return fallback;
  const triple = TRIPLE.exec(raw);
  if (triple) {
    const [, r, g, b] = triple;
    return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return raw;
}

/** Resolve a whole spec object in one pass. */
export function resolveTokens<T extends Record<string, TokenSpec>>(
  spec: T,
): { [K in keyof T]: string } {
  const resolved = {} as { [K in keyof T]: string };
  for (const key of Object.keys(spec) as (keyof T)[]) {
    const entry = spec[key];
    resolved[key] = readTokenColor(entry.token, entry.alpha ?? 1, entry.fallback);
  }
  return resolved;
}

/**
 * The pre-hydration values for a spec — the dark palette. Used so server-rendered
 * SVG and the client's first render agree exactly (no hydration mismatch); the
 * live tokens take over once the charts mount.
 */
export function fallbackTokens<T extends Record<string, TokenSpec>>(
  spec: T,
): { [K in keyof T]: string } {
  const resolved = {} as { [K in keyof T]: string };
  for (const key of Object.keys(spec) as (keyof T)[]) {
    resolved[key] = spec[key].fallback;
  }
  return resolved;
}

/**
 * The loaded monospace stack, with next/font's generated family resolved at
 * runtime, plus the system fallbacks from `tailwind.config.ts`.
 */
export function readMonospaceFamily(fallback: string): string {
  const raw = readCssVariable('--font-mono');
  return raw ? `${raw}, ${fallback}` : fallback;
}

export const MONOSPACE_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';
