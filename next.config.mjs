/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Secrets must never reach the client bundle. Only NEXT_PUBLIC_* names are
  // inlined by Next.js, and we deliberately expose none of the trading,
  // payment or broker credentials.
  env: {},
  experimental: {
    // Next 14 requires the flag: loads src/instrumentation.ts once per server
    // process so the environment contract is validated BEFORE traffic. Without
    // it, a missing variable only surfaces on whichever route needs it first —
    // see the incident note in src/instrumentation.ts.
    instrumentationHook: true,
    serverComponentsExternalPackages: [
      '@prisma/client',
      'ws',
      '@node-rs/argon2',
      'ioredis',
      'speakeasy',
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
