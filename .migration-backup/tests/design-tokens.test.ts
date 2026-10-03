import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { safeConsolePath, safeNextPath } from '@/components/auth/next-path';

/**
 * POST-SIGN-IN DESTINATIONS — two pages, one allow-list.
 *
 * `?next=` is attacker-controllable, so both sign-in surfaces must treat it as
 * untrusted. The console adds one rule on top: the destination has to be inside
 * the console.
 */
describe('safeNextPath (client sign-in)', () => {
  it('keeps a same-site path, including its query', () => {
    expect(safeNextPath('/dashboard/trading?symbol=R_100')).toBe('/dashboard/trading?symbol=R_100');
  });

  it('falls back for anything that leaves the site', () => {
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'dashboard',
      '',
      null,
      undefined,
    ]) {
      expect(safeNextPath(hostile)).toBe('/dashboard');
    }
  });

  it('refuses to bounce back to an auth page', () => {
    expect(safeNextPath('/login')).toBe('/dashboard');
    expect(safeNextPath('/register?next=/login')).toBe('/dashboard');
  });
});

describe('safeConsolePath (console sign-in)', () => {
  it('keeps a console path', () => {
    expect(safeConsolePath('/admin/brokers')).toBe('/admin/brokers');
    expect(safeConsolePath('/admin/bot-control?tab=risk')).toBe('/admin/bot-control?tab=risk');
  });

  it('refuses a client destination — staff land in the console', () => {
    expect(safeConsolePath('/dashboard')).toBe('/admin');
    expect(safeConsolePath('/dashboard/trading')).toBe('/admin');
  });

  it('refuses the console sign-in page itself (no loop)', () => {
    expect(safeConsolePath('/admin/login')).toBe('/admin');
    expect(safeConsolePath('/admin/login?next=/admin')).toBe('/admin');
  });

  it('refuses anything off-site, and defaults to the console', () => {
    for (const hostile of ['https://evil.example', '//evil.example', 'javascript:alert(1)', null]) {
      expect(safeConsolePath(hostile)).toBe('/admin');
    }
  });
});

/**
 * DESIGN TOKENS — the guard that keeps the light console from silently breaking
 * the dark surfaces, and vice versa.
 *
 * Every colour in `tailwind.config.ts` is `rgb(var(--c-…))`. If a variable is
 * missing from a palette, Tailwind emits a declaration the browser drops, and
 * the element falls back to inherited colour — a bug that is invisible in code
 * review and obvious on screen. The dark block is also pinned against the exact
 * literals the config used to hard-code, so "the default look is unchanged" is
 * a test result rather than a claim.
 */
const CONFIG = readFileSync(path.join(process.cwd(), 'tailwind.config.ts'), 'utf8');
const CSS = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

/*
 * Locate the RULES, not the first mention: the file's own header comment
 * describes both selectors, so a naive `indexOf` finds the prose.
 */
const lightRuleStart = CSS.search(/html:has\(\.theme-admin\)\s*\{/);
const darkBlock = CSS.slice(CSS.search(/:root\s*\{/), lightRuleStart);
const lightBlock = CSS.slice(lightRuleStart);

/** `--name: value;` pairs in a CSS block. */
function varsIn(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    vars.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '));
  }
  return vars;
}

/**
 * Every COLOUR variable (`--c-…`) the Tailwind config expects to find. The
 * config also references `--font-sans` and Radix's accordion height, which are
 * not palette.
 */
function referencedVars(): string[] {
  return [
    ...new Set(
      [...CONFIG.matchAll(/var\(--(c-[a-z0-9-]+)\)/g)].map((m) => m[1]!),
    ),
  ].sort();
}

/** Hex literal → the `r g b` triple the palette stores. */
function triple(hex: string): string {
  const value = hex.replace('#', '');
  const parts = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return parts.join(' ');
}

describe('design tokens', () => {
  const dark = varsIn(darkBlock);
  const light = varsIn(lightBlock);

  it('defines every variable the Tailwind config references', () => {
    const missing = referencedVars().filter((name) => !dark.has(name));
    expect(missing).toEqual([]);
  });

  it('keeps the dark palette byte-identical to the literals it replaced', () => {
    // The palette tailwind.config.ts hard-coded before it became variables.
    const historical: Record<string, string> = {
      'c-base': triple('#0B0E14'),
      'c-base-50': triple('#F5F7FA'),
      'c-base-100': triple('#E6EAF2'),
      'c-base-700': triple('#1A1F2B'),
      'c-base-800': triple('#141822'),
      'c-base-850': triple('#10141C'),
      'c-base-900': triple('#0B0E14'),
      'c-base-950': triple('#070910'),
      'c-brand': triple('#22D3EE'),
      'c-brand-50': triple('#ECFEFF'),
      'c-brand-100': triple('#CFFAFE'),
      'c-brand-300': triple('#67E8F9'),
      'c-brand-400': triple('#22D3EE'),
      'c-brand-500': triple('#06B6D4'),
      'c-brand-600': triple('#0891B2'),
      'c-brand-700': triple('#0E7490'),
      'c-profit': triple('#10B981'),
      'c-profit-400': triple('#34D399'),
      'c-profit-500': triple('#10B981'),
      'c-profit-600': triple('#059669'),
      'c-loss': triple('#F43F5E'),
      'c-loss-400': triple('#FB7185'),
      'c-loss-500': triple('#F43F5E'),
      'c-loss-600': triple('#E11D48'),
      'c-warn': triple('#F59E0B'),
      'c-warn-400': triple('#FBBF24'),
      'c-warn-500': triple('#F59E0B'),
      'c-warn-600': triple('#D97706'),
      'c-line': triple('#94A3B8'),
      'c-muted': triple('#94A3B8'),
      // The primary action keeps its dark-theme appearance: cyan fill, near-black label.
      'c-cta': triple('#06B6D4'),
      'c-on-accent': triple('#070910'),
      'c-knob': triple('#070910'),
      'c-scrim': triple('#070910'),
    };

    for (const [name, expected] of Object.entries(historical)) {
      expect(dark.get(name), `--${name}`).toBe(expected);
    }
    expect(dark.get('c-line-a')).toBe('0.14');
    expect(dark.get('c-muted-a')).toBe('0.65');
  });

  it('overrides every surface and text token in the light console', () => {
    // Tokens the light palette MUST restate: surfaces, text, borders, the action
    // colour. Tints (brand-50/100, base-50) are intentionally shared.
    const mustOverride = [
      'c-base',
      'c-base-100',
      'c-base-700',
      'c-base-800',
      'c-base-850',
      'c-base-900',
      'c-base-950',
      'c-brand',
      'c-brand-300',
      'c-brand-400',
      'c-profit',
      'c-profit-400',
      'c-loss',
      'c-loss-400',
      'c-warn',
      'c-warn-400',
      'c-line',
      'c-line-a',
      'c-muted',
      'c-muted-a',
      'c-cta',
      'c-on-accent',
      'c-knob',
      'c-scrim',
    ];
    const missing = mustOverride.filter((name) => !light.has(name));
    expect(missing).toEqual([]);
  });

  it('gives the console a light palette — bright surfaces, dark text, navy action', () => {
    // Slate-50 page, white card, slate-900 text, deep-navy primary action.
    expect(light.get('c-base-900')).toBe(triple('#F8FAFC'));
    expect(light.get('c-base-850')).toBe(triple('#FFFFFF'));
    expect(light.get('c-base-100')).toBe(triple('#0F172A'));
    expect(light.get('c-line')).toBe(triple('#E2E8F0'));
    expect(light.get('c-muted')).toBe(triple('#64748B'));
    expect(light.get('c-cta')).toBe(triple('#0F172A'));
    expect(light.get('c-on-accent')).toBe(triple('#FFFFFF'));
    // Borders are solid on white, not 14%-alpha hairlines.
    expect(light.get('c-line-a')).toBe('1');
  });

  it('scopes the light palette to the console, including portalled dialogs', () => {
    // `html:has(...)`, not the wrapper: Radix portals mount on <body>.
    expect(CSS).toMatch(/html:has\(\.theme-admin\)\s*\{/);
  });
});
