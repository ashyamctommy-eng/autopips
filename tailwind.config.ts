import type { Config } from 'tailwindcss';

/**
 * Autopipsz design system.
 * Dark-mode fintech: #0B0E14 base, cyan / emerald accents.
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
        // Core surfaces
        base: {
          DEFAULT: '#0B0E14',
          50: '#F5F7FA',
          100: '#E6EAF2',
          700: '#1A1F2B',
          800: '#141822',
          850: '#10141C',
          900: '#0B0E14',
          950: '#070910',
        },
        // Brand accent — cyan
        brand: {
          DEFAULT: '#22D3EE',
          50: '#ECFEFF',
          100: '#CFFAFE',
          300: '#67E8F9',
          400: '#22D3EE',
          500: '#06B6D4',
          600: '#0891B2',
          700: '#0E7490',
        },
        // Profit / positive — emerald
        profit: {
          DEFAULT: '#10B981',
          400: '#34D399',
          500: '#10B981',
          600: '#059669',
        },
        loss: {
          DEFAULT: '#F43F5E',
          400: '#FB7185',
          500: '#F43F5E',
          600: '#E11D48',
        },
        warn: {
          DEFAULT: '#F59E0B',
          400: '#FBBF24',
          500: '#F59E0B',
          600: '#D97706',
        },
        line: 'rgba(148, 163, 184, 0.14)',
        muted: 'rgba(148, 163, 184, 0.65)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'grid-dark':
          'linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px)',
        'glow-cyan':
          'radial-gradient(60% 60% at 50% 0%, rgba(34,211,238,0.18) 0%, rgba(11,14,20,0) 100%)',
        'glow-emerald':
          'radial-gradient(60% 60% at 50% 0%, rgba(16,185,129,0.16) 0%, rgba(11,14,20,0) 100%)',
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(148,163,184,0.06) inset, 0 8px 32px -12px rgba(0,0,0,0.8)',
        'glow-cyan': '0 0 32px -8px rgba(34,211,238,0.45)',
        'glow-emerald': '0 0 32px -8px rgba(16,185,129,0.45)',
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
