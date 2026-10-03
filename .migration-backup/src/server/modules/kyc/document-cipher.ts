import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { serverEnv } from '@/lib/env';

/**
 * AES-256-GCM envelope for KYC document BYTES held in Postgres.
 *
 * WHY BYTES, NOT A STRING
 *   `credential-cipher.ts` encrypts short UTF-8 secrets into a `v1.iv.tag.ct`
 *   string. A passport scan is binary and up to 10 MB, so base64-ing it into a
 *   text column would inflate it by a third and hold a second copy in memory.
 *   This module therefore encrypts the raw bytes and stores `iv || tag || ct`
 *   directly in a `Bytes` (BYTEA) column.
 *
 * KEY SEPARATION
 *   The key is derived from the same root secret as every other credential
 *   (`CREDENTIAL_ENCRYPTION_KEY`) but with its own HKDF-style purpose label, so a
 *   document envelope can never be decrypted as a broker token or vice versa.
 *
 * FORMAT
 *   iv  = 12 bytes (96-bit, the GCM standard, fresh for EVERY encryption, so two
 *         encryptions of the same document never share one)
 *   tag = 16 bytes (GCM authentication tag — tampering is detected, not ignored)
 *   ct  = the remainder
 *   A payload shorter than 28 bytes cannot be a valid envelope and is rejected
 *   before `createDecipheriv` sees it.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_ENVELOPE_BYTES = IV_BYTES + TAG_BYTES;

/**
 * The 32-byte AES key for document envelopes.
 *
 * The same root secret as every other credential (`CREDENTIAL_ENCRYPTION_KEY`)
 * with its own HKDF-style purpose label, so a document envelope can never be
 * decrypted as a broker token or vice versa. ROTATION WARNING: rotating the root
 * makes every stored document permanently unreadable — see DEPLOYMENT.md.
 */
function documentKey(): Buffer {
  const root = serverEnv().CREDENTIAL_ENCRYPTION_KEY;
  const raw = /^[A-Za-z0-9+/=]{43,44}$/.test(root)
    ? Buffer.from(root, 'base64')
    : Buffer.from(root, 'utf8');
  if (raw.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must decode to at least 32 bytes (openssl rand -base64 32).',
    );
  }
  return createHash('sha256').update('autopips:kyc-document').update(raw).digest();
}

function toBuffer(value: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/** Encrypt raw document bytes. Returns `iv || authTag || ciphertext`. */
export function encryptDocumentBytes(
  plaintext: Uint8Array | Buffer,
  key: Buffer = documentKey(),
): Buffer {
  const bytes = toBuffer(plaintext);
  if (bytes.length === 0) {
    // An empty document is a client error, caught before storage — but the
    // cipher refuses it too rather than writing an unverifiable row.
    throw new Error('Refusing to encrypt an empty KYC document.');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt a stored envelope. Throws on a malformed envelope or a failed
 * authentication tag — a tampered document is never handed to a reviewer.
 */
export function decryptDocumentBytes(
  envelope: Uint8Array | Buffer,
  key: Buffer = documentKey(),
): Buffer {
  const payload = toBuffer(envelope);
  if (payload.length < MIN_ENVELOPE_BYTES) {
    throw new Error('Malformed KYC document envelope (too short to be iv + tag + ciphertext).');
  }

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, MIN_ENVELOPE_BYTES);
  const ciphertext = payload.subarray(MIN_ENVELOPE_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** SHA-256 (hex) of the plaintext bytes — stored so integrity survives encryption. */
export function documentSha256(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(toBuffer(bytes)).digest('hex');
}
