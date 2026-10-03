import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AppProviders } from './providers';
import { DEFAULT_THEME_PREFERENCE, THEME_INIT_SCRIPT } from '@/lib/theme';

/**
 * Root layout.
 *
 * Note the deliberate absence of any credential in this file: the public site
 * ships the same bundle for anonymous visitors and logged-in clients, so
 * nothing secret may be referenced here. All broker/payment/database access
 * happens behind server modules.
 */

const sans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://autopips.pro'),
  title: {
    default: 'Autopipsz — Automated Trading Infrastructure',
    template: '%s · Autopipsz',
  },
  description:
    'Autopipsz connects client capital to Deriv execution over its WebSocket API, with crypto settlements through NOWPayments. Managed algorithmic trading with verifiable, broker-sourced records. Targets are indicative and non-guaranteed.',
  keywords: [
    'managed trading',
    'algorithmic trading',
    'Deriv',
    'Deriv WebSocket API',
    'copy trading',
    'Autopipsz',
  ],
  openGraph: {
    title: 'Autopipsz — Automated Trading Infrastructure',
    description:
      'Managed algorithmic trading on institutional broker APIs. Verifiable broker-sourced P/L. Targets are indicative and non-guaranteed; capital is at risk.',
    url: process.env.NEXT_PUBLIC_APP_URL ?? 'https://autopips.pro',
    siteName: 'Autopipsz',
    type: 'website',
  },
  robots: { index: true, follow: true },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0B0E14',
  width: 'device-width',
  initialScale: 1,
  /* The mobile bottom navigation pads itself with env(safe-area-inset-*) so it
     clears the iOS home indicator; that only resolves when the layout is
     allowed to paint under it. */
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} dark`}
      data-theme="dark"
      data-theme-preference={DEFAULT_THEME_PREFERENCE}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-base-900 font-sans text-base-100">
        {/*
         * Blocking pre-paint theme script. It must run before the body is
         * parsed so a light-theme visitor never sees a dark frame; it reads the
         * stored preference and stamps `data-theme` on <html>. The server-rendered
         * `data-theme="dark"` above is the no-JavaScript default.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
