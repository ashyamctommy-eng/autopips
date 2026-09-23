import { randomUUID } from 'node:crypto';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { redis, rkey } from '@/lib/redis';
import { serverEnv } from '@/lib/env';
import { AUDIT, recordAudit } from '@/server/modules/audit/audit.service';

/**
 * TOTP two-factor authentication (RFC 6238).
 *
 * Design rules:
 *   • The secret is generated server-side and is returned to the caller EXACTLY
 *     once, over the authenticated `GET /api/v1/auth/2fa/setup` route. It is
 *     never echoed back by any other endpoint and never logged.
 *   • Nothing is persisted until a valid confirming code has been presented
 *     (`enableTwoFactor` verifies BEFORE it writes), so a client cannot lock
 *     themselves out of an account with a secret their authenticator never saw.
 *   • Disabling requires a *currently valid* code, so a stolen access token
 *     alone cannot strip 2FA off an account.
 *   • A correct password does not mint a session when 2FA is on. It only mints a
 *     short-lived, single-use *challenge* — the state between "password was
 *     right" and "TOTP was right" — held in Redis, never in a JWT the client
 *     could keep.
 *
 * Algorithms: the otpauth URL and the verifier are both SHA-1/6-digit/30s, which
 * is what speakeasy defaults to and what every authenticator app supports. They
 * are stated explicitly in both places so neither can drift from the other.
 *
 * Clock drift: verification accepts `window` steps either side of now (±30s by
 * default), which is what every mainstream authenticator assumes.
 */

/** TOTP parameters. Kept as constants so the QR URL and the verifier cannot drift. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** ±1 step (±30s) of clock drift. */
export const TOTP_DEFAULT_WINDOW = 1;

/** How long the password→TOTP bridge stays alive. Deliberately short. */
export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 300;

export interface TwoFactorProvisioning {
  /** Base32 secret — returned only by the authenticated setup route. */
  secret: string;
  /** otpauth:// URL an authenticator app understands; label is `ISSUER:email`. */
  otpauthUrl: string;
  /** PNG data URI of the QR code for `otpauthUrl`. */
  qrDataUrl: string;
}

function challengeKey(challengeId: string): string {
  return rkey('2fa', 'challenge', challengeId);
}

/**
 * Recovery codes are deliberately NOT implemented.
 *
 * A recoverable code must be stored as an Argon2id hash (a plaintext list in a
 * JSON column would be a second password), and `User` in prisma/schema.prisma
 * has no column to hold them — and this module may not touch the schema. Rather
 * than persist them somewhere ad-hoc (Redis is not durable enough to be the only
 * copy of an account-recovery credential), recovery is out of scope: a user who
 * loses their authenticator must go through support, which is auditable.
 */

function assertUsableSecret(secret: string): void {
  // Base32, uppercase A–Z2–7, padding-free — what speakeasy emits and what every
  // authenticator app can import. Rejecting anything else stops a malformed blob
  // from being persisted and bricking the account.
  if (!/^[A-Z2-7]{16,64}$/.test(secret.trim())) {
    throw ApiError.badRequest('That provisioning secret is not a valid base32 TOTP secret.');
  }
}

/** Accepts the code as users type it ("123 456"), rejects everything else. */
export function normaliseTotpToken(token: string): string | null {
  const cleaned = token.replace(/\s+/g, '');
  return /^[0-9]{6,8}$/.test(cleaned) ? cleaned : null;
}

/**
 * Creates a provisioning payload for one user. NOTHING is written to the
 * database here — see `enableTwoFactor`.
 */
export async function generateTwoFactorSecret(user: {
  id: string;
  email: string;
}): Promise<TwoFactorProvisioning> {
  const issuer = serverEnv().TOTP_ISSUER;

  // `length` is the byte count of the random key; 20 bytes → 160 bits, the size
  // RFC 4226 recommends, and a 32-character base32 secret.
  const generated = speakeasy.generateSecret({ length: 20 });
  const secret = generated.base32;

  const otpauthUrl = speakeasy.otpauthURL({
    secret,
    encoding: 'base32',
    // `ISSUER:account` is the Google Authenticator key-URI label format.
    label: `${issuer}:${user.email}`,
    issuer,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    algorithm: 'sha1',
  });

  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  return { secret, otpauthUrl, qrDataUrl };
}

/**
 * Verifies a TOTP code against a base32 secret.
 *
 * `window` widens the accepted counter range by ±`window` steps, so a code that
 * is one step stale (or one step early on a device with a fast clock) still
 * passes. It never accepts an unbounded scan.
 */
export function verifyTotp(secret: string, token: string, window = TOTP_DEFAULT_WINDOW): boolean {
  if (!secret) return false;
  const normalised = normaliseTotpToken(token);
  if (!normalised) return false;

  try {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: normalised,
      window,
      digits: TOTP_DIGITS,
      step: TOTP_PERIOD_SECONDS,
    });
  } catch {
    // A malformed secret must read as "not verified", never as a crash.
    return false;
  }
}

/**
 * Turns 2FA on: verifies the confirming code FIRST, then persists.
 *
 * Order matters. Persisting the secret before the code is confirmed would leave
 * the account with an active second factor that the user's authenticator does
 * not know, i.e. a lockout caused by a typo.
 */
export async function enableTwoFactor(userId: string, secret: string, token: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, is2FAEnabled: true },
  });
  if (!user) throw ApiError.notFound('Account not found.');
  if (user.is2FAEnabled) {
    throw ApiError.conflict('Two-factor authentication is already enabled on this account.');
  }

  const trimmed = secret.trim();
  assertUsableSecret(trimmed);

  if (!verifyTotp(trimmed, token)) {
    throw ApiError.badRequest(
      'That authentication code is not valid. Scan the QR code again and enter the current 6-digit code.',
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: trimmed, is2FAEnabled: true },
  });

  await recordAudit({
    action: AUDIT.AUTH_2FA_ENABLED,
    userId,
    details: { method: 'TOTP', digits: TOTP_DIGITS, periodSeconds: TOTP_PERIOD_SECONDS },
  });
}

/** Turns 2FA off. Requires a currently-valid code from the enrolled device. */
export async function disableTwoFactor(userId: string, token: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, is2FAEnabled: true, twoFactorSecret: true },
  });
  if (!user) throw ApiError.notFound('Account not found.');
  if (!user.is2FAEnabled || !user.twoFactorSecret) {
    throw ApiError.conflict('Two-factor authentication is not enabled on this account.');
  }

  if (!verifyTotp(user.twoFactorSecret, token)) {
    throw ApiError.badRequest('That authentication code is not valid.');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: null, is2FAEnabled: false },
  });

  await recordAudit({
    action: AUDIT.AUTH_2FA_DISABLED,
    userId,
    details: { method: 'TOTP' },
  });
}

/**
 * Creates the password→TOTP bridge for a user whose password was correct.
 *
 * The returned id is the ONLY thing the client holds: it is not a session, it
 * cannot be used for anything else, it expires in five minutes and it is burned
 * on first use. Storing it in Redis (rather than signing it into a JWT) is what
 * makes single-use revocation possible.
 */
export async function issue2faChallenge(userId: string, ip: string | null): Promise<string> {
  const challengeId = randomUUID();
  const payload = JSON.stringify({ userId, ip, issuedAt: new Date().toISOString() });

  await redis.set(
    challengeKey(challengeId),
    payload,
    'EX',
    TWO_FACTOR_CHALLENGE_TTL_SECONDS,
  );

  return challengeId;
}

/**
 * Reads and immediately destroys a challenge (GETDEL semantics).
 *
 * The GET and the DEL run in one MULTI, so the pair is atomic on the server:
 * two concurrent requests with the same id can never both observe the value.
 * Returns the pending userId, or null when the challenge is unknown, expired or
 * already used.
 */
export async function consume2faChallenge(challengeId: string | null | undefined): Promise<string | null> {
  if (!challengeId) return null;

  const key = challengeKey(challengeId);
  const results = await redis.multi().get(key).del(key).exec();
  const raw = results?.[0]?.[1];
  if (typeof raw !== 'string' || raw.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'userId' in parsed) {
      const { userId } = parsed as { userId?: unknown };
      return typeof userId === 'string' && userId.length > 0 ? userId : null;
    }
    return null;
  } catch {
    return null;
  }
}
