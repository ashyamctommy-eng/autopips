import { z } from 'zod';
import type { KycProfile } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { AUDIT, recordAudit, type AuditAction } from '@/server/modules/audit/audit.service';
import type { KycProfileDTO, KycReviewRow, KycStatusValue } from '@/types/api';
import {
  KYC_DOCUMENT_KINDS,
  assertKycDocumentKind,
  attachDocumentsToProfile,
  extensionForContentType,
  findKycDocuments,
  listKycDocuments,
  loadKycDocumentBytes,
  type KycDocumentKind,
} from './storage.service';

/**
 * MANUAL KYC — business directive #5.
 *
 * Identity verification is performed by a human reviewer against documents the
 * platform holds ITSELF: the bytes live encrypted in this platform's Postgres
 * (see ./storage.service.ts and ./document-cipher.ts). There is no external
 * bucket, no object-storage credential and no third-party identity API. This
 * module owns the workflow: submission → queue → under review → decision, plus
 * the access trail every time an admin opens a private document.
 *
 * Two slots only — the FRONT and BACK of one identity document. There is no
 * liveness check and no selfie: the reviewer compares the two images against the
 * details the client declared.
 *
 * ZERO SIMULATION: nothing here invents a verification result. A record only
 * leaves APPROVED because an ADMIN recorded that decision, and that decision is
 * written to AuditLog.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const KYC_STATUSES = [
  'NOT_SUBMITTED',
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'ADDITIONAL_INFO_REQUIRED',
] as const satisfies readonly KycStatusValue[];

export const KYC_ID_TYPES = ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE'] as const;
export type KycIdType = (typeof KYC_ID_TYPES)[number];

export const KYC_DECISIONS = ['APPROVE', 'REJECT', 'REQUEST_MORE_INFO'] as const;
export type KycDecision = (typeof KYC_DECISIONS)[number];

export const KYC_MIN_AGE_YEARS = 18;

const DEFAULT_QUEUE_TAKE = 50;
const MAX_QUEUE_TAKE = 200;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Keep the last four characters, mask everything before them. */
export function maskIdNumber(idNumber: string): string {
  const value = String(idNumber ?? '').trim();
  if (value.length === 0) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse a strict YYYY-MM-DD string into a UTC date, rejecting normalised dates. */
export function parseIsoDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  // Catches 2026-02-30 → 2026-03-02 style roll-over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function toKycProfileDto(
  profile: KycProfile,
  uploadedKinds: readonly string[] = [],
): KycProfileDTO {
  return {
    id: profile.id,
    legalName: profile.legalName,
    dob: toIsoDateOnly(profile.dob),
    address: profile.address,
    idType: profile.idType,
    idNumberMasked: maskIdNumber(profile.idNumber),
    status: profile.status,
    rejectionReason: profile.rejectionReason,
    reviewedAt: profile.reviewedAt ? profile.reviewedAt.toISOString() : null,
    createdAt: profile.createdAt.toISOString(),
    documents: KYC_DOCUMENT_KINDS.map((kind) => ({
      kind,
      uploaded: uploadedKinds.includes(kind),
    })),
  };
}

/** The DTO plus which slots the profile actually has documents in. */
async function toKycProfileDtoWithDocuments(profile: KycProfile): Promise<KycProfileDTO> {
  const documents = await listKycDocuments(profile.id);
  return toKycProfileDto(
    profile,
    documents.map((document) => document.kind),
  );
}

/* -------------------------------------------------------------------------- */
/* Validation schemas                                                          */
/* -------------------------------------------------------------------------- */

const isoDobSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const dob = parseIsoDateOnly(value);
    if (!dob) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date of birth must be a real calendar date in ISO format (YYYY-MM-DD).',
      });
      return;
    }
    if (dob.getTime() > Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Date of birth must be in the past.' });
      return;
    }
    if (ageInYears(dob) < KYC_MIN_AGE_YEARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `You must be at least ${KYC_MIN_AGE_YEARS} years old to open an Autopipsz account.`,
      });
    }
  });

/**
 * A document row id produced by POST /api/v1/kyc/upload.
 *
 * The id grants NOTHING on its own: the bytes are only readable through an
 * ADMIN-authenticated route scoped to the submission, and every read is audited.
 * It is opaque to the client and cannot be used to fetch a file.
 */
const documentIdSchema = z
  .string()
  .trim()
  .min(1, 'A document is required.')
  .max(64, 'Document reference is too long.');

export const submitKycSchema = z
  .object({
    legalName: z.string().trim().min(2, 'Legal name must be at least 2 characters.').max(120),
    dob: isoDobSchema,
    address: z.string().trim().min(5, 'A residential address is required.').max(400),
    idType: z.enum(KYC_ID_TYPES),
    idNumber: z.string().trim().min(3, 'Document number is too short.').max(64),
    idFrontDocumentId: documentIdSchema,
    idBackDocumentId: documentIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Only a passport is reliably single-sided; national ID cards and driving
    // licences carry the document number and/or expiry on the reverse.
    if (value.idType !== 'PASSPORT' && !value.idBackDocumentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idBackDocumentId'],
        message: `The reverse side of a ${value.idType === 'DRIVERS_LICENSE' ? 'driving licence' : 'national ID card'} is required.`,
      });
    }
  });

export type SubmitKycInput = z.infer<typeof submitKycSchema>;

export const kycQueueQuerySchema = z.object({
  status: z.enum(KYC_STATUSES).optional(),
  take: z.coerce.number().int().min(1).max(MAX_QUEUE_TAKE).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export type KycQueueQuery = z.infer<typeof kycQueueQuerySchema>;

const decideKycSchema = z.object({
  id: z.string().trim().min(1),
  adminUserId: z.string().trim().min(1),
  decision: z.enum(KYC_DECISIONS),
  rejectionReason: z.string().trim().max(1000).nullish(),
  ip: z.string().trim().max(64).nullish(),
});

/* -------------------------------------------------------------------------- */
/* Client-facing reads                                                         */
/* -------------------------------------------------------------------------- */

/** The caller's own profile — never includes documents or their bytes. Null when not submitted. */
export async function getMyKyc(userId: string): Promise<KycProfileDTO | null> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId } });
  if (!profile) return null;
  return toKycProfileDtoWithDocuments(profile);
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create or replace the caller's KYC submission.
 *
 * Replacing an existing record resets the review state (a fresh file must be
 * re-reviewed from scratch) and is audited as KYC_RESUBMITTED.
 */
export async function submitKyc(
  userId: string,
  input: unknown,
  ip: string | null = null,
): Promise<KycProfileDTO> {
  const data = submitKycSchema.parse(input);

  const dob = parseIsoDateOnly(data.dob);
  if (!dob) throw ApiError.badRequest('Date of birth must be a real calendar date in ISO format (YYYY-MM-DD).');

  /*
   * Resolve the references against what is actually stored for THIS user before
   * anything is attached. This is the check that stops a submission pointing a
   * reviewer at somebody else's file, and it rejects a reference to a slot this
   * user has not uploaded at all. (The row id is stable across re-uploads of the
   * same slot, so re-uploading does not invalidate a reference — it changes the
   * bytes behind it, which the upload route handles by resetting the review.)
   */
  const stored = await findKycDocuments(userId);
  const front = stored.get('idFront');
  if (!front || front.id !== data.idFrontDocumentId) {
    throw ApiError.badRequest(
      'The front-of-document upload could not be matched to your account. Upload it again and resubmit.',
    );
  }
  const back = stored.get('idBack');
  if (data.idBackDocumentId && (!back || back.id !== data.idBackDocumentId)) {
    throw ApiError.badRequest(
      'The reverse-side upload could not be matched to your account. Upload it again and resubmit.',
    );
  }

  const existing = await prisma.kycProfile.findUnique({ where: { userId } });

  // Both rows must move together: a profile in PENDING whose user is still
  // NOT_SUBMITTED (or vice versa) would stall the review queue.
  const [profile] = await prisma.$transaction([
    prisma.kycProfile.upsert({
      where: { userId },
      create: {
        userId,
        legalName: data.legalName,
        dob,
        address: data.address,
        idType: data.idType,
        idNumber: data.idNumber,
        status: 'PENDING',
      },
      update: {
        legalName: data.legalName,
        dob,
        address: data.address,
        idType: data.idType,
        idNumber: data.idNumber,
        status: 'PENDING',
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
      },
    }),
    prisma.user.update({ where: { id: userId }, data: { kycStatus: 'PENDING' } }),
  ]);

  // Attach the slots this client actually holds: the front (verified above) and
  // the back when one was uploaded. Attaching is what makes a document part of
  // the file under review; a replaced document stays detached until resubmitted.
  const attachedKinds: KycDocumentKind[] = back ? ['idFront', 'idBack'] : ['idFront'];
  await attachDocumentsToProfile({ userId, profileId: profile.id, kinds: attachedKinds });

  await recordAudit({
    action: existing ? AUDIT.KYC_RESUBMITTED : AUDIT.KYC_SUBMITTED,
    userId,
    ipAddress: ip,
    details: {
      kycProfileId: profile.id,
      idType: data.idType,
      // Document row ids are deliberately not written to the audit trail; the
      // slot names are what an investigator needs, and the platform holds the
      // hashes next to the document itself.
      documentKinds: attachedKinds,
      resubmission: Boolean(existing),
      previousStatus: existing ? existing.status : null,
    },
  });

  return toKycProfileDtoWithDocuments(profile);
}

/* -------------------------------------------------------------------------- */
/* Admin: queue + detail                                                       */
/* -------------------------------------------------------------------------- */

export type KycProfileWithUser = KycProfile & {
  user: { id: string; email: string; fullName: string; country: string };
};

function toReviewRow(row: KycProfileWithUser): KycReviewRow {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    fullName: row.user.fullName,
    country: row.user.country,
    legalName: row.legalName,
    idType: row.idType,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * FIFO review queue — oldest submission first so no client is starved behind a
 * rush of newer files.
 */
export async function listKycQueue(input: unknown = {}): Promise<KycReviewRow[]> {
  const { status, take, cursor } = kycQueueQuerySchema.parse(input ?? {});

  const rows = await prisma.kycProfile.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.min(take ?? DEFAULT_QUEUE_TAKE, MAX_QUEUE_TAKE),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, email: true, fullName: true, country: true } } },
  });

  return rows.map(toReviewRow);
}

export interface KycDetailDocument {
  kind: string;
  uploaded: boolean;
  /** Null for an empty slot. */
  contentType: string | null;
  byteLength: number | null;
  /** SHA-256 of the plaintext bytes, so a reviewer can confirm what was stored. */
  sha256: string | null;
  uploadedAt: string | null;
}

export interface KycDetail {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  country: string;
  legalName: string;
  idType: string;
  status: KycStatusValue;
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** Slot metadata only — never bytes, and never a storage key (there is none). */
  documents: KycDetailDocument[];
}

/**
 * Full review payload for one submission.
 *
 * There is no privileged "raw keys" variant any more: documents are read by
 * slot through the audited streaming route, so nothing here can be used to
 * reach the ciphertext directly.
 */
export async function getKycDetail(id: string): Promise<KycDetail> {
  const profile = await prisma.kycProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, fullName: true, country: true } } },
  });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const stored = await listKycDocuments(profile.id);
  const byKind = new Map(stored.map((document) => [document.kind, document]));
  const documents: KycDetailDocument[] = KYC_DOCUMENT_KINDS.map((kind) => {
    const document = byKind.get(kind);
    return document
      ? {
          kind,
          uploaded: true,
          contentType: document.contentType,
          byteLength: document.byteLength,
          sha256: document.sha256,
          uploadedAt: document.uploadedAt,
        }
      : {
          kind,
          uploaded: false,
          contentType: null,
          byteLength: null,
          sha256: null,
          uploadedAt: null,
        };
  });

  return {
    id: profile.id,
    userId: profile.userId,
    email: profile.user.email,
    fullName: profile.user.fullName,
    country: profile.user.country,
    legalName: profile.legalName,
    idType: profile.idType,
    status: profile.status,
    rejectionReason: profile.rejectionReason,
    reviewedBy: profile.reviewedBy,
    reviewedAt: profile.reviewedAt ? profile.reviewedAt.toISOString() : null,
    createdAt: profile.createdAt.toISOString(),
    documents,
  };
}

export type KycDetailClientView = KycDetail;

export function toKycDetailClientView(detail: KycDetail): KycDetailClientView {
  return { ...detail };
}

/**
 * A client replaced a document that was already part of a submitted file.
 *
 * An approval describes the bytes that were reviewed. Once those bytes change the
 * approval can no longer stand, so the submission goes back to PENDING, the
 * reviewer/decision fields are cleared, the user's own KYC status follows, and
 * the change is audited. Without this an APPROVED client could swap their ID
 * image and keep the verified status — the review would describe a file that no
 * longer exists.
 *
 * Safe to call for a profile that does not exist or is not the caller's: it is a
 * no-op, not an error, because the upload itself has already succeeded.
 */
export async function resetSubmissionAfterDocumentReplacement(input: {
  userId: string;
  profileId: string;
  kinds: readonly KycDocumentKind[];
  ip: string | null;
}): Promise<void> {
  const profile = await prisma.kycProfile.findUnique({ where: { id: input.profileId } });
  if (!profile || profile.userId !== input.userId) return;

  const previousStatus = profile.status;

  await prisma.$transaction([
    prisma.kycProfile.update({
      where: { id: profile.id },
      data: { status: 'PENDING', rejectionReason: null, reviewedBy: null, reviewedAt: null },
    }),
    prisma.user.update({ where: { id: input.userId }, data: { kycStatus: 'PENDING' } }),
  ]);

  await recordAudit({
    action: AUDIT.KYC_RESUBMITTED,
    userId: input.userId,
    ipAddress: input.ip,
    details: {
      kycProfileId: profile.id,
      documentKinds: input.kinds,
      reason: 'document_replaced',
      previousStatus,
      status: 'PENDING',
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Admin: private document access                                              */
/* -------------------------------------------------------------------------- */

export interface KycDocumentEntry {
  kind: string;
  uploaded: boolean;
  contentType: string | null;
  byteLength: number | null;
  /** SHA-256 of the plaintext bytes. */
  sha256: string | null;
  uploadedAt: string | null;
  /**
   * Same-origin, ADMIN-authenticated route that streams the bytes — NOT a
   * pre-signed bearer URL. There is nothing to leak, nothing to expire and
   * nothing that works outside a signed-in admin session.
   */
  url: string | null;
}

/**
 * The review-dialog manifest: which slots this submission holds, and where the
 * audited stream for each one lives.
 *
 * ACCESS TRAIL: this is what a reviewer opens first, so it writes
 * KYC_DOCUMENT_VIEWED with `phase: 'manifest'`. Serving the bytes themselves
 * writes a second entry with `phase: 'download'` (see streamKycDocument), which
 * is the row that proves a document was actually opened.
 */
export async function getKycDocumentManifest(
  id: string,
  adminUserId: string,
  ip: string | null = null,
): Promise<KycDocumentEntry[]> {
  if (!adminUserId || !adminUserId.trim()) {
    throw ApiError.forbidden('A reviewer identity is required to open KYC documents.');
  }

  const profile = await prisma.kycProfile.findUnique({ where: { id } });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const stored = await listKycDocuments(profile.id);
  const byKind = new Map(stored.map((document) => [document.kind, document]));

  const entries: KycDocumentEntry[] = KYC_DOCUMENT_KINDS.map((kind) => {
    const document = byKind.get(kind);
    if (!document) {
      return {
        kind,
        uploaded: false,
        contentType: null,
        byteLength: null,
        sha256: null,
        uploadedAt: null,
        url: null,
      };
    }
    return {
      kind,
      uploaded: true,
      contentType: document.contentType,
      byteLength: document.byteLength,
      sha256: document.sha256,
      uploadedAt: document.uploadedAt,
      url: `/api/v1/admin/kyc/${profile.id}/documents/${kind}`,
    };
  });

  await recordAudit({
    action: AUDIT.KYC_DOCUMENT_VIEWED,
    userId: adminUserId,
    ipAddress: ip,
    details: {
      phase: 'manifest',
      kycProfileId: profile.id,
      targetUserId: profile.userId,
      documentKinds: stored.map((document) => document.kind),
    },
  });

  return entries;
}

export interface KycDocumentStream {
  bytes: Buffer;
  contentType: string;
  /** Safe, server-derived filename: `<kind>.<ext>`. The client's own filename is not stored. */
  filename: string;
  byteLength: number;
}

/**
 * Load ONE document for a reviewer and audit the access.
 *
 * ADMIN-only at the route. Scoped by the PROFILE that owns the document (not by
 * a client-supplied document id), so the request cannot be pointed at another
 * client's file. Returns null when the slot is empty; a ciphertext that fails
 * its authentication tag is reported as an integrity failure rather than served.
 */
export async function streamKycDocument(input: {
  profileId: string;
  kind: string;
  adminUserId: string;
  ip: string | null;
}): Promise<KycDocumentStream | null> {
  if (!input.adminUserId || !input.adminUserId.trim()) {
    throw ApiError.forbidden('A reviewer identity is required to open KYC documents.');
  }
  const kind = assertKycDocumentKind(input.kind);

  const profile = await prisma.kycProfile.findUnique({
    where: { id: input.profileId },
    select: { id: true, userId: true },
  });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  let document: Awaited<ReturnType<typeof loadKycDocumentBytes>>;
  try {
    document = await loadKycDocumentBytes({ profileId: profile.id, kind });
  } catch (err) {
    // A failed auth tag means the stored bytes were tampered with, or
    // CREDENTIAL_ENCRYPTION_KEY was rotated without re-encrypting. Either way the
    // document must NOT be served, and the operator needs a loud signal.
    console.error(
      `[kyc] could not decrypt ${kind} for profile ${profile.id}:`,
      err instanceof Error ? err.message : 'unknown error',
    );
    await recordAudit({
      action: AUDIT.KYC_DOCUMENT_VIEWED,
      userId: input.adminUserId,
      ipAddress: input.ip,
      details: {
        phase: 'download_failed',
        kycProfileId: profile.id,
        targetUserId: profile.userId,
        documentKind: kind,
        error: err instanceof Error ? err.message : 'unknown error',
      },
    });
    throw ApiError.internal('The stored document could not be read. It was not served — report this to an operator.');
  }

  if (!document) return null;

  // Written only once the bytes are in hand: an audit entry means a document was
  // served, not merely requested.
  await recordAudit({
    action: AUDIT.KYC_DOCUMENT_VIEWED,
    userId: input.adminUserId,
    ipAddress: input.ip,
    details: {
      phase: 'download',
      kycProfileId: profile.id,
      targetUserId: profile.userId,
      documentKind: kind,
      byteLength: document.byteLength,
      sha256: document.sha256,
    },
  });

  return {
    bytes: document.bytes,
    contentType: document.contentType,
    filename: `${kind}.${extensionForContentType(document.contentType)}`,
    byteLength: document.byteLength,
  };
}

/* -------------------------------------------------------------------------- */
/* Admin: decisions                                                            */
/* -------------------------------------------------------------------------- */

const DECISION_STATUS: Record<KycDecision, KycStatusValue> = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  REQUEST_MORE_INFO: 'ADDITIONAL_INFO_REQUIRED',
};

const DECISION_AUDIT: Record<KycDecision, AuditAction> = {
  APPROVE: AUDIT.KYC_APPROVED,
  REJECT: AUDIT.KYC_REJECTED,
  REQUEST_MORE_INFO: AUDIT.KYC_ADDITIONAL_INFO_REQUESTED,
};

export interface DecideKycInput {
  id: string;
  adminUserId: string;
  decision: KycDecision;
  rejectionReason?: string | null;
  ip?: string | null;
}

/** Record an approval, rejection or information request against a submission. */
export async function decideKyc(input: DecideKycInput): Promise<KycProfileDTO> {
  const { id, adminUserId, decision, rejectionReason, ip } = decideKycSchema.parse(input);

  const profile = await prisma.kycProfile.findUnique({ where: { id } });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const reason = (rejectionReason ?? '').trim();
  if (decision === 'REJECT' && !reason) {
    throw ApiError.badRequest('A rejection reason is required when rejecting a KYC submission.');
  }
  if (decision === 'REQUEST_MORE_INFO' && !reason) {
    throw ApiError.badRequest('A reason is required when requesting additional information.');
  }

  const reversal = profile.status === 'APPROVED' && decision === 'REJECT';
  if (profile.status === 'APPROVED' && !reversal) {
    throw ApiError.conflict(
      'This KYC record is already APPROVED. Only a reversal (REJECT) is permitted.',
    );
  }

  const status = DECISION_STATUS[decision];
  const reviewedAt = new Date();

  const [updated] = await prisma.$transaction([
    prisma.kycProfile.update({
      where: { id },
      data: {
        status,
        reviewedBy: adminUserId,
        reviewedAt,
        rejectionReason: decision === 'APPROVE' ? null : reason,
      },
    }),
    prisma.user.update({ where: { id: profile.userId }, data: { kycStatus: status } }),
  ]);

  await recordAudit({
    action: DECISION_AUDIT[decision],
    userId: adminUserId,
    ipAddress: ip ?? null,
    details: {
      kycProfileId: profile.id,
      targetUserId: profile.userId,
      decision,
      previousStatus: profile.status,
      status,
      reason: decision === 'APPROVE' ? null : reason,
      // Reversing a live approval is allowed for admins, but it is never silent.
      reversal,
    },
  });

  return toKycProfileDtoWithDocuments(updated);
}

/** Move a submission to UNDER_REVIEW and hand it to a named reviewer. */
export async function markUnderReview(id: string, adminUserId: string): Promise<KycProfileDTO> {
  if (!adminUserId || !adminUserId.trim()) {
    throw ApiError.forbidden('A reviewer identity is required.');
  }

  const profile = await prisma.kycProfile.findUnique({ where: { id } });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const [updated] = await prisma.$transaction([
    prisma.kycProfile.update({
      where: { id },
      data: { status: 'UNDER_REVIEW', reviewedBy: adminUserId },
    }),
    prisma.user.update({ where: { id: profile.userId }, data: { kycStatus: 'UNDER_REVIEW' } }),
  ]);

  await recordAudit({
    action: AUDIT.KYC_REVIEW_STARTED,
    userId: adminUserId,
    ipAddress: null,
    details: {
      kycProfileId: profile.id,
      targetUserId: profile.userId,
      previousStatus: profile.status,
      status: 'UNDER_REVIEW',
    },
  });

  return toKycProfileDtoWithDocuments(updated);
}
