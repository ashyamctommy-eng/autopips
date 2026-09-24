import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { decryptCredential, encryptCredential, maskSecret } from '@/lib/crypto/credential-cipher';

/**
 * Operator-editable platform settings.
 *
 * WHAT THIS IS FOR
 *   Provider credentials used to be readable only from environment variables, so
 *   rotating a NOWPayments key or a MetaApi token meant editing service variables
 *   and redeploying. These settings let an administrator change the handful of
 *   values that are safe to manage at runtime, from the admin console.
 *
 * THE RULE (one direction only)
 *   A stored row OVERRIDES the environment variable of the same meaning. The env
 *   var remains the fallback and the default, so:
 *     • a deployment is never broken by a missing console row;
 *     • clearing a row puts the env value back — no data loss, no lockout;
 *     • nothing that is NOT in this list can be changed from the console.
 *
 * SECRETS
 *   `isSecret` keys are stored as AES-256-GCM envelopes (credential-cipher),
 *   never plaintext, and are only ever returned to the console masked. An
 *   encrypted value that fails to decrypt (e.g. after a CREDENTIAL_ENCRYPTION_KEY
 *   rotation) is skipped with a warning and the env fallback is used — a broken
 *   row cannot take the platform down.
 *
 * READ PATH
 *   `getSetting()` is SYNCHRONOUS on purpose: it is called from the payment
 *   client and the IPN verifier, which are hot paths. It reads an in-process
 *   cache and kicks a background refresh at most once per TTL. Writes refresh
 *   the cache eagerly, so a change made in the console is live immediately in
 *   the process that served it (other replicas converge within the TTL).
 */

// ─── definitions ─────────────────────────────────────────────────────────────

export type PlatformSettingKey =
  | 'nowpayments.api_key'
  | 'nowpayments.ipn_secret'
  | 'nowpayments.api_base'
  | 'nowpayments.allowed_currencies'
  | 'deriv.api_token'
  // ── bot risk controls (Admin → Bot control) ──
  | 'bot.enabled'
  | 'bot.disabled_reason'
  | 'risk.max_stake_usd'
  | 'risk.daily_loss_limit_usd'
  | 'risk.allowed_symbols'
  | 'risk.min_payout_percentage';

type SettingKind = 'secret' | 'url' | 'list' | 'symbols' | 'number' | 'boolean' | 'text';

interface SettingDefinition {
  key: PlatformSettingKey;
  envName: string;
  label: string;
  description: string;
  kind: SettingKind;
  /** Used when neither a console row nor the env var is present. */
  defaultValue: string;
  inputHint: string;
}

/**
 * The complete set of keys the console may edit. Everything else on this
 * platform stays in service variables (and is validated at boot by src/lib/env.ts).
 * A key is listed here only if some code path actually reads it — advertising a
 * toggle that nothing honours would be a lie.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'nowpayments.api_key',
    envName: 'NOWPAYMENTS_API_KEY',
    label: 'NOWPayments API key',
    description:
      'Sent as `x-api-key` on every deposit/payout call. Replacing it takes effect on the next payment request — no redeploy.',
    kind: 'secret',
    defaultValue: '',
    inputHint: 'e.g. 8XK4-…-2QW1',
  },
  {
    key: 'nowpayments.ipn_secret',
    envName: 'NOWPAYMENTS_IPN_SECRET',
    label: 'NOWPayments IPN secret',
    description:
      'HMAC-SHA512 key used to verify incoming payment callbacks. If this does not match the NOWPayments dashboard, deposits are rejected with DEPOSIT_IPN_REJECTED and never credited.',
    kind: 'secret',
    defaultValue: '',
    inputHint: 'From NOWPayments → Settings → Payments → IPN secret',
  },
  {
    key: 'nowpayments.api_base',
    envName: 'NOWPAYMENTS_API_BASE',
    label: 'NOWPayments API base URL',
    description: 'Override only for a sandbox/proxy endpoint. Production: https://api.nowpayments.io/v1',
    kind: 'url',
    defaultValue: 'https://api.nowpayments.io/v1',
    inputHint: 'https://api.nowpayments.io/v1',
  },
  {
    key: 'nowpayments.allowed_currencies',
    envName: 'NOWPAYMENTS_ALLOWED_CURRENCIES',
    label: 'Accepted deposit currencies',
    description:
      'Comma-separated tickers. This is the list clients may choose from, intersected with what the provider reports as live.',
    kind: 'list',
    defaultValue: 'usdttrc20,usdterc20,btc,eth,ltc,trx,bnb',
    inputHint: 'usdttrc20,usdterc20,btc',
  },
  {
    key: 'deriv.api_token',
    envName: 'DERIV_API_TOKEN',
    label: 'Deriv API token',
    description:
      'Account API token used to authenticate the broker connection (balance, portfolio and trading; it needs the “trade” scope to place orders). Without one the platform still streams public market data, but nothing authenticated works. A token stored against a specific connection in Admin → Brokers wins over this one.',
    kind: 'secret',
    defaultValue: '',
    inputHint: 'api.deriv.com → API token (read + trade scopes)',
  },

  // ── bot risk controls ─────────────────────────────────────────────────────
  // These live in Admin → Bot control. `bot.enabled` is ALSO mirrored into Redis
  // (see bot-control.service.ts) because a kill switch has to take effect in the
  // worker process immediately, not on the settings cache's TTL.
  {
    key: 'bot.enabled',
    envName: 'BOT_ENABLED',
    label: 'Bot trading enabled',
    description:
      'The global kill switch. false rejects every new order immediately, in every process, and pauses the bot runtime.',
    kind: 'boolean',
    defaultValue: 'true',
    inputHint: 'true or false',
  },
  {
    key: 'bot.disabled_reason',
    envName: 'BOT_DISABLED_REASON',
    label: 'Kill switch reason',
    description: 'Why trading was stopped. Shown in the console and written to the audit log with the state change.',
    kind: 'text',
    defaultValue: '',
    inputHint: 'e.g. broker incident, risk review',
  },
  {
    key: 'risk.max_stake_usd',
    envName: 'RISK_MAX_STAKE_USD',
    label: 'Maximum stake per order (USD)',
    description:
      'Upper bound on the stake of a single contract. 0 disables the cap. A contract broker sizes orders by stake, so the cap is enforced where the stake is known — when an order is priced.',
    kind: 'number',
    defaultValue: '0',
    inputHint: 'e.g. 250',
  },
  {
    key: 'risk.daily_loss_limit_usd',
    envName: 'RISK_DAILY_LOSS_LIMIT_USD',
    label: 'Daily realised-loss limit (USD)',
    description:
      'New orders are refused once realised P/L for the UTC day is at or below minus this amount. 0 disables the limit.',
    kind: 'number',
    defaultValue: '0',
    inputHint: 'e.g. 500',
  },
  {
    key: 'risk.min_payout_percentage',
    envName: 'RISK_MIN_PAYOUT_PERCENTAGE',
    label: 'Minimum payout percentage',
    description:
      'A contract whose quoted payout is below this percentage of its cost is refused. 0 disables the check. Only meaningful for contracts that quote a payout.',
    kind: 'number',
    defaultValue: '0',
    inputHint: 'e.g. 90',
  },
  {
    key: 'risk.allowed_symbols',
    envName: 'RISK_ALLOWED_SYMBOLS',
    label: 'Tradable symbols (allow-list)',
    description:
      'Comma-separated broker symbols the bot may trade. Empty means no restriction. Symbols are case-sensitive. Charting is never restricted — this gates orders only.',
    kind: 'symbols',
    defaultValue: '',
    inputHint: 'e.g. frxXAUUSD,R_100',
  },
] as const;

const DEFINITIONS_BY_KEY = new Map<string, SettingDefinition>(
  SETTING_DEFINITIONS.map((def) => [def.key, def]),
);

// ─── validation ──────────────────────────────────────────────────────────────

const LIST_TOKEN = /^[a-z0-9]{2,16}$/i;

/** Throws ApiError.badRequest with a message written for an operator, not a stack trace. */
function validateValue(def: SettingDefinition, value: string): string {
  const trimmed = value.trim();

  if (def.kind === 'secret') {
    if (trimmed.length < 8) {
      throw ApiError.badRequest(`${def.label} is too short — expected at least 8 characters.`);
    }
    if (/\s/.test(trimmed)) {
      throw ApiError.badRequest(`${def.label} must not contain spaces or line breaks.`);
    }
    return trimmed;
  }

  if (def.kind === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw ApiError.badRequest(`${def.label} must be an absolute URL, e.g. https://api.nowpayments.io/v1`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw ApiError.badRequest(`${def.label} must use http(s).`);
    }
    return trimmed.replace(/\/+$/, '');
  }

  if (def.kind === 'boolean') {
    const normalised = trimmed.toLowerCase();
    if (normalised !== 'true' && normalised !== 'false') {
      throw ApiError.badRequest(`${def.label} must be true or false.`);
    }
    return normalised;
  }

  if (def.kind === 'text') {
    if (trimmed.length > 500) {
      throw ApiError.badRequest(`${def.label} is limited to 500 characters.`);
    }
    return trimmed;
  }

  if (def.kind === 'number') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw ApiError.badRequest(`${def.label} must be a number.`);
    }
    if (parsed < 0) {
      throw ApiError.badRequest(`${def.label} cannot be negative.`);
    }
    return String(parsed);
  }

  if (def.kind === 'symbols') {
    // Broker symbols are case-sensitive (Deriv uses `frxXAUUSD`, `R_100`), so
    // this list is NOT lower-cased.
    const symbols = trimmed
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    const bad = symbols.find((token) => !/^[A-Za-z0-9._#+-]{2,32}$/.test(token));
    if (bad) {
      throw ApiError.badRequest(
        `${def.label}: "${bad}" is not a valid broker symbol.`,
      );
    }
    // An empty list is meaningful: "no restriction" — the console clears the row.
    return Array.from(new Set(symbols)).join(',');
  }

  // list
  const tokens = trimmed
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw ApiError.badRequest(`${def.label} needs at least one ticker.`);
  }
  const bad = tokens.find((t) => !LIST_TOKEN.test(t));
  if (bad) {
    throw ApiError.badRequest(`${def.label}: "${bad}" is not a valid ticker (letters/digits, 2–16 chars).`);
  }
  return Array.from(new Set(tokens)).join(',');
}

// ─── cache + hydration ───────────────────────────────────────────────────────

const TTL_MS = 30_000;
const RETRY_MS = 5_000;

/** key → effective override (decrypted). Absent = use the env fallback. */
const overrides = new Map<string, string>();
let hydratedAt = 0;
let inFlight: Promise<void> | null = null;
let lastFailureAt = 0;

async function hydrate(): Promise<void> {
  const rows = await prisma.platformSetting.findMany();
  const next = new Map<string, string>();

  for (const row of rows) {
    const def = DEFINITIONS_BY_KEY.get(row.key);
    if (!def) continue; // row for a key this build no longer reads — ignore

    let value = row.value;
    if (row.isSecret) {
      try {
        value = decryptCredential(row.value);
      } catch {
        console.error(
          `[settings] could not decrypt "${row.key}" (CREDENTIAL_ENCRYPTION_KEY changed?) — falling back to the environment value.`,
        );
        continue;
      }
    }
    if (value.trim()) next.set(row.key, value);
  }

  overrides.clear();
  for (const [key, value] of next) overrides.set(key, value);
  hydratedAt = Date.now();
}

function hydrateInBackground(): void {
  if (Date.now() - hydratedAt < TTL_MS) return;
  if (inFlight) return;
  if (lastFailureAt && Date.now() - lastFailureAt < RETRY_MS) return;

  inFlight = hydrate()
    .catch((err) => {
      // A settings read must never break a payment. Keep serving the env values.
      lastFailureAt = Date.now();
      console.error('[settings] refresh failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Await a fresh read (admin console; after a write). */
export async function ensureSettingsLoaded(force = false): Promise<void> {
  if (!force && Date.now() - hydratedAt < TTL_MS) return;
  try {
    await hydrate();
  } catch (err) {
    lastFailureAt = Date.now();
    if (force) throw err;
    console.error('[settings] refresh failed:', err instanceof Error ? err.message : err);
  }
}

// ─── read ────────────────────────────────────────────────────────────────────

/**
 * The effective value: console override if present, else the env var, else the
 * definition's default. Never throws — a settings outage degrades to the
 * environment, it does not stop deposits.
 */
export function getSetting(key: PlatformSettingKey): string {
  hydrateInBackground();
  const override = overrides.get(key);
  if (typeof override === 'string' && override.length > 0) return override;

  const def = DEFINITIONS_BY_KEY.get(key)!;
  const fromEnv = (process.env[def.envName] ?? '').trim();
  return fromEnv || def.defaultValue;
}

/** True when a console row (not the environment) is supplying the value. */
export function isOverridden(key: PlatformSettingKey): boolean {
  const override = overrides.get(key);
  return typeof override === 'string' && override.length > 0;
}

/**
 * A numeric setting, with the definition's default when unset or unparsable.
 * Never NaN: a bad row degrades to the default instead of disabling a limit.
 */
export function getSettingNumber(key: PlatformSettingKey): number {
  const raw = getSetting(key).trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    const fallback = Number(DEFINITIONS_BY_KEY.get(key)?.defaultValue ?? '0');
    console.warn(`[settings] "${key}" holds a non-numeric value; using the default ${fallback}.`);
    return Number.isFinite(fallback) ? fallback : 0;
  }
  return parsed;
}

/** A case-preserving symbol allow-list. Empty array = no restriction. */
export function getSettingSymbols(key: PlatformSettingKey): string[] {
  return getSetting(key)
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean);
}

/** The accepted-deposit currency list, honouring a console override. */
export function resolvedAllowedCurrencies(): string[] {
  return getSetting('nowpayments.allowed_currencies')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

// ─── admin console ───────────────────────────────────────────────────────────

export interface AdminSettingView {
  key: PlatformSettingKey;
  label: string;
  description: string;
  kind: SettingKind;
  secret: boolean;
  inputHint: string;
  /** Where the effective value comes from right now. */
  source: 'console' | 'environment' | 'unset';
  /** Masked for secrets; verbatim for everything else. Never a secret. */
  display: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function listAdminSettings(): Promise<AdminSettingView[]> {
  await ensureSettingsLoaded(true);
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return SETTING_DEFINITIONS.map((def) => {
    const row = byKey.get(def.key) ?? null;
    const fromConsole = Boolean(row && (def.kind === 'secret' ? true : row.value.trim()));
    const envValue = (process.env[def.envName] ?? '').trim();

    let display: string | null = null;
    if (row && row.value.trim()) {
      if (def.kind === 'secret') {
        // The stored value is an envelope; mask its plaintext length only.
        let plaintext = '';
        try {
          plaintext = decryptCredential(row.value);
        } catch {
          plaintext = '';
        }
        display = plaintext ? maskSecret(plaintext) : '********';
      } else {
        display = row.value;
      }
    } else if (envValue) {
      display = def.kind === 'secret' ? maskSecret(envValue) : envValue;
    }

    return {
      key: def.key,
      label: def.label,
      description: def.description,
      kind: def.kind,
      secret: def.kind === 'secret',
      inputHint: def.inputHint,
      source: fromConsole ? 'console' : envValue ? 'environment' : 'unset',
      display,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row ? row.updatedBy : null,
    };
  });
}

/**
 * Set or clear one setting.
 *
 * `null` (or an empty string) DELETES the row, which is how an operator reverts
 * to the environment value. The plaintext of a secret is never logged or
 * returned; callers audit the key and the action only.
 */
export async function saveAdminSetting(
  key: string,
  rawValue: string | null,
  actor: { id: string; email: string },
): Promise<{ key: string; action: 'set' | 'cleared' }> {
  const def = DEFINITIONS_BY_KEY.get(key);
  if (!def) {
    throw ApiError.badRequest(`"${key}" is not an editable platform setting.`);
  }

  const value = (rawValue ?? '').trim();

  if (value.length === 0) {
    await prisma.platformSetting.deleteMany({ where: { key: def.key } });
    await ensureSettingsLoaded(true);
    return { key: def.key, action: 'cleared' };
  }

  const validated = validateValue(def, value);
  const stored = def.kind === 'secret' ? encryptCredential(validated, 'generic') : validated;

  await prisma.platformSetting.upsert({
    where: { key: def.key },
    create: {
      key: def.key,
      value: stored,
      isSecret: def.kind === 'secret',
      updatedBy: actor.email,
    },
    update: {
      value: stored,
      isSecret: def.kind === 'secret',
      updatedBy: actor.email,
    },
  });

  // Make the change live in this process immediately; other replicas pick it up
  // on their next refresh tick.
  await ensureSettingsLoaded(true);

  return { key: def.key, action: 'set' };
}
