import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serverEnv } from '@/lib/env';
import { ApiError } from '@/lib/http';

/**
 * PRIVATE KYC DOCUMENT STORAGE — business directive #5.
 *
 * There is no third-party identity-verification API in this platform. Identity
 * documents go to a PRIVATE S3 bucket and leave it only as short-lived,
 * pre-signed GET URLs minted for a signed-in ADMIN during manual review.
 *
 * Hard rules enforced by this module:
 *  1. Encryption at rest is mandatory on every PUT. SSE-KMS with
 *     AWS_KMS_KEY_ID when configured, otherwise SSE-S3 (AES256). A caller can
 *     never pass their own encryption parameters or turn encryption off.
 *  2. Object keys are non-guessable: kyc/<userId>/<uuid>/<kind>-<uuid>.<ext>.
 *     Nothing sequential, nothing derived from the client's filename.
 *  3. No public URL is ever produced. The only URL this module can mint is a
 *     pre-signed GetObject URL. Requests that would grant public/anonymous
 *     access (canned ACLs, URI grants for AllUsers/AuthenticatedUsers) are
 *     rejected by a client middleware guard.
 *  4. Signed URLs are capped at 300 seconds — see KYC_SIGNED_URL_TTL_HARD_CAP.
 *  5. Credentials are never read, stored, logged or echoed here. The SDK's
 *     default provider chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
 *     shared config file, or the workload/instance role) resolves them.
 */

/** Maximum accepted size for a single document upload. */
export const KYC_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/** The four document slots a KYC submission may carry. */
export const KYC_DOCUMENT_KINDS = ['idFront', 'idBack', 'proofOfAddress', 'selfie'] as const;
export type KycDocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];

/** Types of identity document we accept. Anything else is rejected outright. */
export const KYC_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type KycAllowedContentType = (typeof KYC_ALLOWED_CONTENT_TYPES)[number];

/** Default lifetime of an admin review link, in seconds. */
export const KYC_SIGNED_URL_DEFAULT_TTL_SECONDS = 300;

/**
 * ADMIN-REVIEW REQUIREMENT — hard cap.
 *
 * A signed KYC document URL is a bearer credential: anyone holding it can
 * download a passport scan. Review links are therefore issued for at most five
 * minutes, no matter what a caller asks for and no matter what
 * KYC_SIGNED_URL_TTL is misconfigured to. 300 seconds is enough for an admin to
 * click through the file list and open a document, and short enough that a
 * leaked link is useless.
 */
export const KYC_SIGNED_URL_TTL_HARD_CAP_SECONDS = 300;

const EXTENSION_BY_CONTENT_TYPE: Record<KycAllowedContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Canned ACLs that would expose the object beyond the bucket owner. */
const FORBIDDEN_CANNED_ACLS = new Set(['public-read', 'public-read-write', 'authenticated-read']);

/** Grant URIs that hand access to everyone / to any AWS account. */
const FORBIDDEN_GRANT_MARKERS = [
  'groups/global/AllUsers',
  'groups/global/AuthenticatedUsers',
];

const GRANT_FIELDS = ['GrantRead', 'GrantWrite', 'GrantReadACP', 'GrantWriteACP', 'GrantFullControl'] as const;

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
 * BEFORE anything is sent to S3, and again by uploadKycDocument so the service
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
/* Object keys                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * kyc/<userId>/<uuid>/<kind>-<uuid>.<ext>
 *
 * Two independent v4 UUIDs make the key unguessable even for an attacker who
 * knows the user id, and the extension is derived from the validated content
 * type rather than the (attacker-controlled) filename.
 */
export function buildKycObjectKey(
  userId: string,
  kind: KycDocumentKind,
  contentType: string,
): string {
  if (!userId || !userId.trim()) throw ApiError.badRequest('A user id is required to store a KYC document.');
  if (!(KYC_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw ApiError.badRequest(`Unknown KYC document kind "${String(kind)}".`);
  }
  return `kyc/${userId}/${randomUUID()}/${kind}-${randomUUID()}.${extensionForContentType(contentType)}`;
}

/* -------------------------------------------------------------------------- */
/* Encryption                                                                  */
/* -------------------------------------------------------------------------- */

export interface KycEncryptionParams {
  ServerSideEncryption: 'aws:kms' | 'AES256';
  SSEKMSKeyId?: string;
  BucketKeyEnabled?: boolean;
}

/**
 * Mandatory SSE parameters for every PUT.
 *
 * Prefers SSE-KMS with the platform's customer-managed key; falls back to
 * SSE-S3 (AES256) only when no KMS key id is configured. There is no code path
 * that omits encryption and no parameter for a caller to weaken it.
 */
export function kycEncryptionParams(): KycEncryptionParams {
  const kmsKeyId = serverEnv().AWS_KMS_KEY_ID?.trim();
  if (kmsKeyId) {
    return {
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyId,
      // Bucket keys cut KMS request cost without changing the protection level.
      BucketKeyEnabled: true,
    };
  }
  return { ServerSideEncryption: 'AES256' };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

let cachedClient: S3Client | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Last line of defence: inspect every request this client builds and refuse it
 * if it could grant access outside the bucket owner.
 */
export function assertNoPublicAccessRequest(input: unknown): void {
  if (!isRecord(input)) return;

  const acl = input.ACL;
  if (typeof acl === 'string' && acl.trim().toLowerCase() !== 'private') {
    const normalized = acl.trim().toLowerCase();
    throw new Error(
      FORBIDDEN_CANNED_ACLS.has(normalized)
        ? `Refusing S3 request: canned ACL "${acl}" would expose KYC documents publicly.`
        : `Refusing S3 request: canned ACL "${acl}" is not permitted on the private KYC bucket.`,
    );
  }

  for (const field of GRANT_FIELDS) {
    const grant = input[field];
    if (typeof grant !== 'string') continue;
    const lowered = grant.toLowerCase();
    if (FORBIDDEN_GRANT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
      throw new Error(
        `Refusing S3 request: ${field} would grant public access to the private KYC bucket.`,
      );
    }
  }
}

/**
 * Client configuration for the private KYC bucket.
 *
 * - `region` comes from AWS_REGION.
 * - `credentials` is deliberately NOT set: the SDK default provider chain
 *   resolves AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or the instance role).
 *   This module never receives or logs a secret.
 * - No endpoint/ACL/website configuration is ever attached, so the client
 *   cannot address the bucket as a public website.
 */
export function buildS3ClientConfig(): S3ClientConfig {
  const env = serverEnv();
  return { region: env.AWS_REGION };
}

/** Lazily-constructed S3 client singleton. */
export function getS3Client(): S3Client {
  if (cachedClient) return cachedClient;

  const client = new S3Client(buildS3ClientConfig());
  client.middlewareStack.add(
    (next) => async (args) => {
      assertNoPublicAccessRequest(args.input);
      return next(args);
    },
    { name: 'kycPrivateBucketAccessGuard', step: 'initialize', priority: 'high' },
  );

  cachedClient = client;
  return cachedClient;
}

function bucket(): string {
  return serverEnv().AWS_KYC_BUCKET;
}

/** Printable-ASCII copy of the client's filename, used only as object metadata. */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\r\n]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim()
    .slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* Upload / delete / sign                                                      */
/* -------------------------------------------------------------------------- */

export interface UploadKycDocumentInput {
  userId: string;
  kind: KycDocumentKind;
  filename: string;
  contentType: string;
  /** Raw document bytes. */
  bytes: Buffer | Uint8Array;
}

/**
 * Store one document in the private bucket.
 * @returns the S3 object KEY (never a URL — a URL only ever comes from
 *          getSignedDocumentUrl, and only for an ADMIN).
 */
export async function uploadKycDocument(input: UploadKycDocumentInput): Promise<string> {
  const contentType = assertValidKycDocument({
    contentType: input.contentType,
    byteLength: input.bytes.byteLength,
  });

  const key = buildKycObjectKey(input.userId, input.kind, contentType);
  const originalFilename = sanitizeFilename(input.filename);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: input.bytes,
      ContentType: contentType,
      ContentLength: input.bytes.byteLength,
      // Mandatory encryption — not overridable by the caller.
      ...kycEncryptionParams(),
      ...(originalFilename ? { Metadata: { 'original-filename': originalFilename } } : {}),
    }),
  );

  return key;
}

/**
 * Remove one document. Used by GDPR/erasure cleanup, so it is best-effort
 * idempotent: deleting an already-absent key is not an error.
 */
export async function deleteKycDocument(key: string): Promise<void> {
  if (!key || !key.trim()) throw ApiError.badRequest('A KYC document key is required.');
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * Resolve the effective signed-URL lifetime.
 *
 * Always min(requested, KYC_SIGNED_URL_TTL, 300). A caller asking for an hour
 * still gets five minutes; a deployment that sets KYC_SIGNED_URL_TTL=86400 is
 * still clamped to five minutes.
 */
export function resolveSignedUrlTtl(requestedSeconds?: number | null): number {
  const configured = serverEnv().KYC_SIGNED_URL_TTL;
  const base = Math.min(
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : KYC_SIGNED_URL_DEFAULT_TTL_SECONDS,
    KYC_SIGNED_URL_TTL_HARD_CAP_SECONDS,
  );

  if (
    requestedSeconds === undefined ||
    requestedSeconds === null ||
    !Number.isFinite(requestedSeconds) ||
    requestedSeconds <= 0
  ) {
    return base;
  }
  return Math.max(1, Math.min(Math.floor(requestedSeconds), base, KYC_SIGNED_URL_TTL_HARD_CAP_SECONDS));
}

/**
 * Mint a pre-signed GET URL for one private object.
 *
 * ADMIN-REVIEW REQUIREMENT: the lifetime is hard-capped at 300 seconds (5
 * minutes) even when a larger `ttlSeconds` is requested, and it can never
 * exceed KYC_SIGNED_URL_TTL. This is the only way a document can be read —
 * the bucket has no public objects and this module never builds a public URL.
 */
export async function getSignedDocumentUrl(key: string, ttlSeconds?: number): Promise<string> {
  if (!key || !key.trim()) throw ApiError.badRequest('A KYC document key is required.');

  const expiresIn = resolveSignedUrlTtl(ttlSeconds);
  return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn,
  });
}

export type KycObjectState = 'present' | 'missing' | 'unknown';

/**
 * Cheap HEAD probe so a review screen can say "document no longer in storage"
 * instead of handing the admin a link that 404s. A pre-signed URL can be
 * generated offline for an object that does not exist, so existence is checked
 * explicitly.
 */
export async function getKycDocumentState(key: string): Promise<KycObjectState> {
  if (!key || !key.trim()) return 'missing';
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return 'present';
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name ?? '';
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return 'missing';
    console.error('[kyc] HEAD probe failed:', name || (err instanceof Error ? err.message : 'unknown'));
    return 'unknown';
  }
}
