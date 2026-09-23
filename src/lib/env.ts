import { z } from 'zod';

/**
 * Server-side environment contract.
 *
 * CRITICAL: this module must only ever be imported from server code
 * (src/server/**, src/app/api/**, route handlers, server components).
 * Importing it into a client component will fail the build on purpose —
 * `server-only` guards the boundary so no secret can leak into the browser
 * bundle or into localStorage.
 */

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: z.string().url().default('https://autopips.pro'),
  NEXT_PUBLIC_APP_NAME: z.string().default('Autopipsz'),

  // Socket / bot runtime
  WS_PORT: z.coerce.number().int().positive().default(4001),
  WS_INTERNAL_TOKEN: z.string().min(16),

  // Datastores
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_TLS: booleanish.default('false'),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('autopips.pro'),
  JWT_AUDIENCE: z.string().default('autopips-pro-clients'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000),
  TOTP_ISSUER: z.string().default('Autopipsz'),

  // Credential encryption at rest
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),

  // S3
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_KYC_BUCKET: z.string().min(1),
  AWS_KMS_KEY_ID: z.string().optional().or(z.literal('')),
  KYC_SIGNED_URL_TTL: z.coerce.number().int().positive().default(300),

  // NOWPayments
  NOWPAYMENTS_API_KEY: z.string().min(1),
  NOWPAYMENTS_API_BASE: z.string().url().default('https://api.nowpayments.io/v1'),
  NOWPAYMENTS_IPN_SECRET: z.string().min(1),
  NOWPAYMENTS_PAYOUT_WALLET: z.string().optional().or(z.literal('')),
  NOWPAYMENTS_PAYOUT_CURRENCY: z.string().default('usdttrc20'),
  NOWPAYMENTS_ALLOWED_CURRENCIES: z.string().default('usdttrc20,usdterc20,btc,eth,ltc,trx,bnb'),

  // MetaApi
  METAAPI_TOKEN: z.string().min(1),
  METAAPI_REGION: z.string().default('new-york'),
  METAAPI_SYNC_INTERVAL: z.coerce.number().int().positive().default(15),
  METAAPI_RISK_MANAGEMENT_ENABLED: booleanish.default('true'),
  METAAPI_TERMINAL_TIMEOUT: z.coerce.number().int().positive().default(120),

  // Risk
  RISK_MASTER_EQUITY_FLOOR_USD: z.coerce.number().nonnegative().default(0),
  RISK_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(50),
  RISK_MAX_LOT_PER_ORDER: z.coerce.number().positive().default(10),
  RISK_MIN_CLIENT_CAPITAL_USD: z.coerce.number().nonnegative().default(100),
  RISK_HWM_ENABLED: booleanish.default('true'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * Parse + validate process.env exactly once per process.
 * Fails fast and loudly at boot rather than at the first trade.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      'Invalid or missing server environment variables:\n' +
        formatIssues(parsed.error) +
        '\n\nCopy .env.example to .env and populate every value.',
    );
  }

  // Guard: a secret must never be exposed to the client bundle.
  for (const key of Object.keys(parsed.data)) {
    if (key.startsWith('NEXT_PUBLIC_') && /SECRET|TOKEN|KEY|PASSWORD/i.test(key)) {
      throw new Error(
        `Refusing to boot: ${key} looks like a secret but is NEXT_PUBLIC_* and would leak to the browser.`,
      );
    }
  }

  cached = parsed.data;
  return cached;
}

/** Comma-separated allow-list → array. */
export function allowedCurrencies(env: ServerEnv = serverEnv()): string[] {
  return env.NOWPAYMENTS_ALLOWED_CURRENCIES.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}
