import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import {
  decryptDocumentBytes,
  documentSha256,
  encryptDocumentBytes,
} from './document-cipher';

/**
 * KYC DOCUMENT STORAGE — internal, encrypted, no third-party service.
 *
 * The platform holds identity documents itself. There is no S3 bucket, no
 * object-storage credential and no third-party identity API anywhere on this
 * path: the bytes live in `KycDocument.ciphertext` in the platform's own
 * Postgres, encrypted at rest with AES-256-GCM (`document-cipher.ts`).
 *
 * Hard rules enforced here:
 *  1. Only two slots exist — the FRONT and BACK of one identity document. There
 *     is no liveness check and no selfie: verification is a human reviewer
 *     comparing the two images against the declared details.
 *  2. Type and size are checked BEFORE anything is encrypted or written, twice
 *     (once in the route for a fast error, once here so the rule cannot be
 *     bypassed by another caller).
 *  3. Bytes are never returned to a client. The only read path is
 *     `loadKycDocumentBytes`, called by the ADMIN-only route that streams a
 *     document to a reviewer and audits the access. There is no pre-signed URL
 *     and therefore no bearer credential that can leak.
 *  4. The declared filename is NOT stored: it is attacker-controlled, it is not
 *     needed to review the image, and keeping it would be one more piece of PII
 *     to protect.
 *  5. Re-uploading a slot REPLACES the stored bytes (one row per user per slot).
 *     The replacement STAYS attached to the submission it belonged to, and the
 *     caller resets that submission's review state — see
 *     `resetSubmissionAfterDocumentReplacement` in kyc.service.ts. Detaching it
 *     instead (the first implementation of this) let an APPROVED client swap the
 *     image underneath their approval while the profile still read APPROVED and
 *     the reviewer's next look found an empty slot.
 */

/** Maximum accepted size for a single document upload. */
export const KYC_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The document slots. Deliberately just two: the front and back of one identity
 * document. Adding a slot here is the only thing needed to extend the form, the
 * upload route and the reviewer UI, which all derive from this list.
 */
export const KYC_DOCUMENT_KINDS = ['idFront', 'idBack'] as const;
export type KycDocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];

/** Types of identity document we accept. Anything else is rejected outright. */
export const KYC_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type KycAllowedContentType = (typeof KYC_ALLOWED_CONTENT_TYPES)[number];

const EXTENSION_BY_CONTENT_TYPE: Record<KycAllowedContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** "image/jpeg; charset=utf-8" → "image/jpeg". */
export function normalizeContentType(raw: string): string {
  return raw.split(';')[0]!.trim().toLowerCase();
}

export function isAllowedKycContentType(raw: string): boolean {
  return (KYC_ALLOWED_CONTENT_TYPES as readonly string[]).includes(normalizeContentType(raw));
}

export function extensionForContentType(contentType: string): string {
  const normalized = normalizeContentType(contentType) as KycAllowedContentType;
  return EXTENSION_BY_CONTENT_TYPE[normalized] ?? 'bin';
}

/** Throws unless the kind is one of the two known slots. */
export function assertKycDocumentKind(kind: string): KycDocumentKind {
  if (!(KYC_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw ApiError.badRequest(
      `Unknown KYC document slot "${kind}". Expected one of: ${KYC_DOCUMENT_KINDS.join(', ')}.`,
    );
  }
  return kind as KycDocumentKind;
}

/** Throws unless the content type is on the allow-list. Returns the normalized type. */
export function assertKycContentType(contentType: string): KycAllowedContentType {
  const normalized = normalizeContentType(contentType);
  if (!(KYC_ALLOWED_CONTENT_TYPES as readonly string[]).includes(normalized)) {
    throw ApiError.badRequest(
      `Unsupported KYC document type "${contentType}". Allowed types: ${KYC_ALLOWED_CONTENT_TYPES.join(', ')}.`,
    );
  }
  return normalized as KycAllowedContentType;
}

/** Throws unless the payload is non-empty and at most KYC_MAX_DOCUMENT_BYTES. */
export function assertKycDocumentSize(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw ApiError.badRequest('KYC document is empty.');
  }
  if (byteLength > KYC_MAX_DOCUMENT_BYTES) {
    throw ApiError.badRequest(
      `KYC document exceeds the ${KYC_MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit (received ${byteLength} bytes).`,
    );
  }
}

/**
 * Single entry point for the type + size rules. Called by the upload route
 * BEFORE anything is encrypted, and again by uploadKycDocument so the service
 * cannot be bypassed.
 */
export function assertValidKycDocument(input: {
  contentType: string;
  byteLength: number;
}): KycAllowedContentType {
  const contentType = assertKycContentType(input.contentType);
  assertKycDocumentSize(input.byteLength);
  return contentType;
}

/* -------------------------------------------------------------------------- */
/* Reads (metadata only — never bytes)                                         */
/* -------------------------------------------------------------------------- */

/** What a submission DTO and the reviewer's file list may see. */
export interface StoredKycDocument {
  id: string;
  kind: KycDocumentKind;
  contentType: string;
  byteLength: number;
  sha256: string;
  uploadedAt: string;
}

export interface UploadKycDocumentInput {
  userId: string;
  kind: KycDocumentKind;
  contentType: string;
  /** Raw document bytes. */
  bytes: Buffer | Uint8Array;
}

/**
 * Store (or replace) one document slot and return its row id.
 *
 * The row is created DETACHED (`profileId = null`): it becomes part of a
 * submission only when `submitKyc()` attaches it, which is also what resets the
 * review state. Returning the id — instead of an opaque storage key — is what
 * lets the submit call reference the document without the client ever holding
 * anything that grants access to the bytes.
 */
export interface UploadKycDocumentResult {
  /** Row id of the stored document (stable across re-uploads of the same slot). */
  id: string;
  /**
   * The submission this slot was ALREADY attached to, when the upload replaced a
   * file a reviewer had already been given. Non-null means the bytes behind a
   * review (or an approval) have changed, and the caller MUST reset that
   * submission's review state — an approval must never survive a document being
   * swapped underneath it.
   */
  replacedAttachedProfileId: string | null;
}

/**
 * Store (or replace) one document slot.
 *
 * The row is created DETACHED (`profileId: null`) and becomes part of a
 * submission only when `submitKyc()` attaches it. Returning the id — instead of
 * an opaque storage key — is what lets the submit call reference the document
 * without the client ever holding anything that grants access to the bytes.
 */
export async function uploadKycDocument(
  input: UploadKycDocumentInput,
): Promise<UploadKycDocumentResult> {
  const kind = assertKycDocumentKind(input.kind);
  const contentType = assertValidKycDocument({
    contentType: input.contentType,
    byteLength: input.bytes.byteLength,
  });

  const plaintext = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const ciphertext = encryptDocumentBytes(plaintext);
  const sha256 = documentSha256(plaintext);

  // Read first: the update below must know whether it is overwriting bytes that
  // a submission already points at, so the caller can reset the review.
  const existing = await prisma.kycDocument.findUnique({
    where: { userId_kind: { userId: input.userId, kind } },
    select: { profileId: true },
  });

  const row = await prisma.kycDocument.upsert({
    where: { userId_kind: { userId: input.userId, kind } },
    create: {
      userId: input.userId,
      kind,
      contentType,
      byteLength: plaintext.byteLength,
      sha256,
      ciphertext,
    },
    update: {
      kind,
      contentType,
      byteLength: plaintext.byteLength,
      sha256,
      ciphertext,
      // `profileId` is deliberately NOT cleared. The replacement stays part of the
      // submission it belongs to, so a reviewer opening the file sees the file
      // that is actually on record; the caller resets the review state instead.
    },
    select: { id: true },
  });

  return { id: row.id, replacedAttachedProfileId: existing?.profileId ?? null };
}

/** Metadata for one user's stored slots. Absent slot = not uploaded. */
export async function findKycDocuments(
  userId: string,
  kinds: readonly KycDocumentKind[] = KYC_DOCUMENT_KINDS,
): Promise<Map<KycDocumentKind, StoredKycDocument>> {
  const rows = await prisma.kycDocument.findMany({
    where: { userId, kind: { in: [...kinds] } },
    select: { id: true, kind: true, contentType: true, byteLength: true, sha256: true, updatedAt: true },
  });

  const byKind = new Map<KycDocumentKind, StoredKycDocument>();
  for (const row of rows) {
    if (!(KYC_DOCUMENT_KINDS as readonly string[]).includes(row.kind)) continue;
    byKind.set(row.kind as KycDocumentKind, {
      id: row.id,
      kind: row.kind as KycDocumentKind,
      contentType: row.contentType,
      byteLength: row.byteLength,
      sha256: row.sha256,
      uploadedAt: row.updatedAt.toISOString(),
    });
  }
  return byKind;
}

/** Metadata for the documents attached to one submitted profile, in slot order. */
export async function listKycDocuments(profileId: string): Promise<StoredKycDocument[]> {
  const rows = await prisma.kycDocument.findMany({
    where: { profileId },
    select: { id: true, kind: true, contentType: true, byteLength: true, sha256: true, updatedAt: true },
  });

  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return KYC_DOCUMENT_KINDS.flatMap((kind) => {
    const row = byKind.get(kind);
    if (!row) return [];
    return [
      {
        id: row.id,
        kind,
        contentType: row.contentType,
        byteLength: row.byteLength,
        sha256: row.sha256,
        uploadedAt: row.updatedAt.toISOString(),
      } satisfies StoredKycDocument,
    ];
  });
}

/**
 * Attach the caller's documents to their submission.
 *
 * Refuses when a required slot is missing, so a profile can never be PENDING
 * while pointing at no file — the review queue would stall on it.
 */
export async function attachDocumentsToProfile(input: {
  userId: string;
  profileId: string;
  kinds: readonly KycDocumentKind[];
}): Promise<void> {
  const result = await prisma.kycDocument.updateMany({
    where: { userId: input.userId, kind: { in: [...input.kinds] } },
    data: { profileId: input.profileId },
  });

  if (result.count < input.kinds.length) {
    throw ApiError.badRequest(
      'A required document was not uploaded. Upload the front and back of your identity document and try again.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Reads (bytes) — the single, audited path to a document                      */
/* -------------------------------------------------------------------------- */

export interface KycDocumentBytes {
  kind: KycDocumentKind;
  contentType: string;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
}

/**
 * Load and decrypt one document for a reviewer.
 *
 * Scoped by the PROFILE that owns it, so an admin request for
 * `/admin/kyc/<profileId>/documents/<kind>` cannot be pointed at another
 * client's file. Returns null when the slot is empty; throws when the stored
 * envelope fails its authentication tag (a tampered document is never served).
 */
export async function loadKycDocumentBytes(input: {
  profileId: string;
  kind: KycDocumentKind;
}): Promise<KycDocumentBytes | null> {
  const row = await prisma.kycDocument.findFirst({
    where: { profileId: input.profileId, kind: input.kind },
    select: { kind: true, contentType: true, byteLength: true, sha256: true, ciphertext: true },
  });
  if (!row) return null;

  const bytes = decryptDocumentBytes(row.ciphertext);
  return {
    kind: input.kind,
    contentType: row.contentType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    bytes,
  };
}

/** Remove one document slot (GDPR erasure / a client withdrawing a file). */
export async function deleteKycDocument(userId: string, kind: KycDocumentKind): Promise<void> {
  await prisma.kycDocument.deleteMany({ where: { userId, kind } });
}
