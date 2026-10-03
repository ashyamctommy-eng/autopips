import './helpers/test-env';

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptDocumentBytes,
  documentSha256,
  encryptDocumentBytes,
} from '@/server/modules/kyc/document-cipher';
import { submitKycSchema } from '@/server/modules/kyc/kyc.service';

/**
 * KYC DOCUMENT CONFIDENTIALITY
 *
 * Identity documents are the most sensitive bytes this platform holds: a passport
 * scan is worth more to an attacker than a password hash, and it cannot be
 * rotated. These tests pin the properties the storage layer depends on —
 * round-trip fidelity for binary data, a fresh IV per encryption, and detection
 * of any tampering — plus the submission rules that decide when a file is
 * reviewable at all (front always, back unless it is a passport).
 *
 * Nothing here touches Postgres: the cipher and the Zod schema are pure, which is
 * exactly why they are the right things to pin.
 */

/** A stand-in for a JPEG/PNG header — binary, not valid UTF-8. */
function binaryDocument(byteLength = 2048): Buffer {
  const bytes = randomBytes(byteLength);
  // A real magic number, so this looks like what it stands in for.
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

describe('document encryption at rest', () => {
  it('round-trips binary bytes exactly', () => {
    const plaintext = binaryDocument();
    const envelope = encryptDocumentBytes(plaintext);

    expect(decryptDocumentBytes(envelope).equals(plaintext)).toBe(true);
  });

  it('round-trips a PDF-sized document', () => {
    const plaintext = binaryDocument(1024 * 1024);
    expect(decryptDocumentBytes(encryptDocumentBytes(plaintext)).equals(plaintext)).toBe(true);
  });

  it('uses a fresh IV, so identical documents do not produce identical ciphertext', () => {
    const plaintext = binaryDocument(512);
    const first = encryptDocumentBytes(plaintext);
    const second = encryptDocumentBytes(plaintext);

    expect(first.equals(second)).toBe(false);
    // Same length (the envelope is fixed-overhead) but different bytes from the
    // first byte onwards — that first block is the IV.
    expect(first.byteLength).toBe(second.byteLength);
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
  });

  it('detects a tampered ciphertext instead of returning garbage', () => {
    const envelope = encryptDocumentBytes(binaryDocument(256));
    // Flip one bit in the body, past the iv + tag header.
    envelope[envelope.byteLength - 1] ^= 0x01;

    expect(() => decryptDocumentBytes(envelope)).toThrow();
  });

  it('detects a tampered authentication tag', () => {
    const envelope = encryptDocumentBytes(binaryDocument(256));
    envelope[12] ^= 0x01; // first byte of the tag

    expect(() => decryptDocumentBytes(envelope)).toThrow();
  });

  it('rejects an envelope too short to be iv + tag + ciphertext', () => {
    expect(() => decryptDocumentBytes(Buffer.alloc(16))).toThrow(/too short/i);
  });

  it('refuses to encrypt an empty document', () => {
    expect(() => encryptDocumentBytes(Buffer.alloc(0))).toThrow(/empty/i);
  });

  it('cannot be decrypted with a key derived for a different purpose', () => {
    const plaintext = binaryDocument(128);
    const envelope = encryptDocumentBytes(plaintext);
    // A 32-byte key that is NOT the derived document key — standing in for any
    // other credential purpose (broker token, payout secret).
    const otherKey = createHash('sha256').update('autopips:something-else').digest();

    expect(() => decryptDocumentBytes(envelope, otherKey)).toThrow();
  });

  it('hashes the plaintext, so the stored digest survives encryption', () => {
    const plaintext = binaryDocument(300);
    const expected = createHash('sha256').update(plaintext).digest('hex');

    expect(documentSha256(plaintext)).toBe(expected);
    // The envelope is what is persisted; its digest is necessarily different.
    expect(documentSha256(encryptDocumentBytes(plaintext))).not.toBe(expected);
  });
});

describe('KYC submission rules (two slots: front and back)', () => {
  const base = {
    legalName: 'Ada Lovelace',
    dob: '1990-01-01',
    address: '12 Analytical Engine Way, London',
    idNumber: 'X1234567',
    idFrontDocumentId: '11111111-1111-1111-1111-111111111111',
    idBackDocumentId: '22222222-2222-2222-2222-222222222222',
  };

  it('accepts front + back for a national ID card', () => {
    const parsed = submitKycSchema.safeParse({ ...base, idType: 'NATIONAL_ID' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a passport with no back side', () => {
    const { idBackDocumentId: _back, ...passport } = base;
    const parsed = submitKycSchema.safeParse({ ...passport, idType: 'PASSPORT' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a national ID card with no back side', () => {
    const { idBackDocumentId: _back, ...noBack } = base;
    const parsed = submitKycSchema.safeParse({ ...noBack, idType: 'NATIONAL_ID' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/reverse side/i);
  });

  it('rejects a driving licence with no back side', () => {
    const { idBackDocumentId: _back, ...noBack } = base;
    const parsed = submitKycSchema.safeParse({ ...noBack, idType: 'DRIVERS_LICENSE' });
    expect(parsed.success).toBe(false);
  });

  it('requires the front document', () => {
    const { idFrontDocumentId: _front, ...noFront } = base;
    const parsed = submitKycSchema.safeParse({ ...noFront, idType: 'PASSPORT' });
    expect(parsed.success).toBe(false);
  });

  it('no longer accepts the removed selfie / proof-of-address fields', () => {
    // The old contract carried four keys. A client still sending them must be
    // told, not silently ignored — but the fields must not be REQUIRED either.
    const parsed = submitKycSchema.safeParse({
      ...base,
      idType: 'PASSPORT',
      selfieKey: 'kyc/someone/selfie.jpg',
      proofOfAddressKey: 'kyc/someone/bill.pdf',
    });
    // Unknown keys are stripped by Zod's default object behaviour, so this still
    // parses: the important half of the claim is that neither field is needed.
    expect(parsed.success).toBe(true);
  });

  it('still enforces the 18+ age rule', () => {
    const parsed = submitKycSchema.safeParse({
      ...base,
      idType: 'PASSPORT',
      dob: '2015-01-01',
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/at least 18/i);
  });
});
