import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { serverEnv } from '@/lib/env';

/**
 * AES-256-GCM envelope for credentials that must live in the database
 * (MetaApi account tokens, payout wallet keys).
 *
 * Rules enforced here:
 *  - Plaintext never leaves the server.
 *  - Every encryption uses a fresh 96-bit IV; the auth tag is stored alongside.
 *  - The stored string is `v1.<iv>.<tag>.<ciphertext>` (all base64url), so the
 *    format is versioned and can be rotated.
 *  - A distinct AES key is derived per purpose via HKDF-style SHA-256, so a
 *    token encrypted for `metaapi` cannot be decrypted as a `payout` secret.
 */

const VERSION = 'v1';

function keyFor(purpose: string): Buffer {
  const root = serverEnv().CREDENTIAL_ENCRYPTION_KEY;
  const raw = /^[A-Za-z0-9+/=]{43,44}$/.test(root)
    ? Buffer.from(root, 'base64')
    : Buffer.from(root, 'utf8');
  if (raw.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must decode to at least 32 bytes (openssl rand -base64 32).',
    );
  }
  // purpose-separated 32-byte key
  return createHash('sha256').update(`autopips:${purpose}`).update(raw).digest();
}

export type CredentialPurpose = 'metaapi' | 'payout' | 'generic';

export function encryptCredential(plaintext: string, purpose: CredentialPurpose = 'generic'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptCredential(payload: string, purpose: CredentialPurpose = 'generic'): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted credential payload.');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(purpose),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Render only the tail of a secret for admin display: "***a1b2". */
export function maskSecret(secret: string, visible = 4): string {
  if (!secret) return '';
  const tail = secret.slice(-visible);
  return `${'*'.repeat(Math.max(3, secret.length - visible))}${tail}`;
}

/** Mask a broker account login the way the UI shows it: "***-9012". */
export function maskAccount(login: string): string {
  const digits = login.replace(/\D/g, '');
  return `***-${digits.slice(-4).padStart(4, '*')}`;
}
