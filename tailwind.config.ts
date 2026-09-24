import type { Config } from 'tailwindcss';

/**
 * Autopipsz design system.
 *
 * Dark-by-default fintech: #0B0E14 base, cyan / emerald accents — the public
 * site and the client trading workspace. The admin console runs a light
 * "executive" palette from the same tokens (see `globals.css`, `.theme-admin`),
 * so both surfaces share one set of primitives.
 *
 * The literal palette lives in `src/app/globals.css` as CSS variables.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        /*
         * Every colour is a CSS VARIABLE, not a literal.
         *
         * The dark values in `src/app/globals.css` under `:root` are exactly the
         * literals this file used to hard-code, so the default rendering is
         * unchanged — but the palette can now be swapped per surface. The admin
         * console does that (`html:has(.theme-admin)`), and it is what makes a
         * user-facing light/dark toggle a one-block change instead of a sweep
         * through every component.
         *
         * Channel triples (`11 14 20`) rather than hex, so Tailwind's opacity
         * modifiers keep working: `bg-base-900/40` must stay 40% of the SURFACE
         * colour, in whichever theme is active.
         */
        base: {
          DEFAULT: 'rgb(var(--c-base) / <alpha-value>)',
          50: 'rgb(var(--c-base-50) / <alpha-value>)',
          100: 'rgb(var(--c-base-100) / <alpha-value>)',
          700: 'rgb(var(--c-base-700) / <alpha-value>)',
          800: 'rgb(var(--c-base-800) / <alpha-value>)',
          850: 'rgb(var(--c-base-850) / <alpha-value>)',
          900: 'rgb(var(--c-base-900) / <alpha-value>)',
          950: 'rgb(var(--c-base-950) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          50: 'rgb(var(--c-brand-50) / <alpha-value>)',
          100: 'rgb(var(--c-brand-100) / <alpha-value>)',
          300: 'rgb(var(--c-brand-300) / <alpha-value>)',
          400: 'rgb(var(--c-brand-400) / <alpha-value>)',
          500: 'rgb(var(--c-brand-500) / <alpha-value>)',
          600: 'rgb(var(--c-brand-600) / <alpha-value>)',
          700: 'rgb(var(--c-brand-700) / <alpha-value>)',
        },
        profit: {
          DEFAULT: 'rgb(var(--c-profit) / <alpha-value>)',
          400: 'rgb(var(--c-profit-400) / <alpha-value>)',
          500: 'rgb(var(--c-profit-500) / <alpha-value>)',
          600: 'rgb(var(--c-profit-600) / <alpha-value>)',
        },
        loss: {
          DEFAULT: 'rgb(var(--c-loss) / <alpha-value>)',
          400: 'rgb(var(--c-loss-400) / <alpha-value>)',
          500: 'rgb(var(--c-loss-500) / <alpha-value>)',
          600: 'rgb(var(--c-loss-600) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--c-warn) / <alpha-value>)',
          400: 'rgb(var(--c-warn-400) / <alpha-value>)',
          500: 'rgb(var(--c-warn-500) / <alpha-value>)',
          600: 'rgb(var(--c-warn-600) / <alpha-value>)',
        },
        /*
         * The primary call-to-action. Its own token pair rather than `brand`:
         * a cyan fill with near-black text is right on the dark trading surface,
         * and unreadable in a light back office, where the same button is deep
         * navy with white text. One primitive, two palettes.
         */
        cta: {
          DEFAULT: 'rgb(var(--c-cta) / <alpha-value>)',
        },
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        /* Switch thumb: needs contrast against BOTH palettes' tracks. */
        knob: 'rgb(var(--c-knob) / <alpha-value>)',
        /* Modal / drawer backdrop. Must stay dark in BOTH themes. */
        scrim: 'rgb(var(--c-scrim) / var(--c-scrim-a))',
        /*
         * Hairlines and muted text carry a DEFAULT alpha, so `border-line/60`
         * must scale it rather than replace it: `calc(0.14 * 0.6)`.
         */
        line: 'rgb(var(--c-line) / calc(var(--c-line-a) * <alpha-value>))',
        muted: 'rgb(var(--c-muted) / calc(var(--c-muted-a) * <alpha-value>))',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        // Textures are themeable: a near-black grid is invisible on white.
        'grid-dark': 'var(--bg-grid)',
        'glow-cyan': 'var(--bg-glow-cyan)',
        'glow-emerald': 'var(--bg-glow-emerald)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        cta: 'var(--shadow-cta)',
        'glow-cyan': 'var(--shadow-glow-cyan)',
        'glow-emerald': 'var(--shadow-glow-emerald)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(16,185,129,0.5)' },
          '70%': { boxShadow: '0 0 0 10px rgba(16,185,129,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(16,185,129,0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        shimmer: 'shimmer 2s infinite',
        'pulse-ring': 'pulse-ring 2s infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
