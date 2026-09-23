import { z } from 'zod';
import type { KycProfile, Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { AUDIT, recordAudit, type AuditAction } from '@/server/modules/audit/audit.service';
import type { KycProfileDTO, KycReviewRow, KycStatusValue } from '@/types/api';
import {
  KYC_DOCUMENT_KINDS,
  getKycDocumentState,
  getSignedDocumentUrl,
  resolveSignedUrlTtl,
  type KycDocumentKind,
} from './storage.service';

/**
 * MANUAL KYC — business directive #5.
 *
 * Identity verification is performed by a human reviewer against documents held
 * in the private S3 bucket (see ./storage.service.ts). This module owns the
 * workflow: submission → queue → under review → decision, plus the access trail
 * every time an admin opens a private document.
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

function documentKeyFor(profile: KycProfile, kind: KycDocumentKind): string | null {
  switch (kind) {
    case 'idFront':
      return profile.idFrontKey;
    case 'idBack':
      return profile.idBackKey ?? null;
    case 'proofOfAddress':
      return profile.proofOfAddressKey;
    case 'selfie':
      return profile.selfieKey;
    default:
      return null;
  }
}

export function toKycProfileDto(profile: KycProfile): KycProfileDTO {
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
      uploaded: Boolean(documentKeyFor(profile, kind)),
    })),
  };
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

/** Private-bucket object keys are opaque; reject anything path-like. */
const objectKeySchema = z
  .string()
  .trim()
  .min(1, 'A document key is required.')
  .max(512, 'Document key is too long.')
  .refine((key) => !key.startsWith('/'), 'Document key must be a relative S3 object key.')
  .refine((key) => !key.includes('..'), 'Document key must not contain path traversal.');

export const submitKycSchema = z
  .object({
    legalName: z.string().trim().min(2, 'Legal name must be at least 2 characters.').max(120),
    dob: isoDobSchema,
    address: z.string().trim().min(5, 'A residential address is required.').max(400),
    idType: z.enum(KYC_ID_TYPES),
    idNumber: z.string().trim().min(3, 'Document number is too short.').max(64),
    idFrontKey: objectKeySchema,
    idBackKey: objectKeySchema.optional(),
    proofOfAddressKey: objectKeySchema,
    selfieKey: objectKeySchema,
  })
  .superRefine((value, ctx) => {
    // A driving licence always has a reverse side; passports and most national
    // IDs are single-sided.
    if (value.idType === 'DRIVERS_LICENSE' && !value.idBackKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idBackKey'],
        message: 'The reverse side of a driving licence is required (idBackKey).',
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

/** The caller's own profile — never includes object keys. Null when not submitted. */
export async function getMyKyc(userId: string): Promise<KycProfileDTO | null> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId } });
  if (!profile) return null;
  return toKycProfileDto(profile);
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

  for (const [field, key] of Object.entries({
    idFrontKey: data.idFrontKey,
    proofOfAddressKey: data.proofOfAddressKey,
    selfieKey: data.selfieKey,
    ...(data.idBackKey ? { idBackKey: data.idBackKey } : {}),
  })) {
    assertKeyBelongsToUser(key, userId, field);
  }

  const dob = parseIsoDateOnly(data.dob);
  if (!dob) throw ApiError.badRequest('Date of birth must be a real calendar date in ISO format (YYYY-MM-DD).');

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
        idFrontKey: data.idFrontKey,
        idBackKey: data.idBackKey ?? null,
        proofOfAddressKey: data.proofOfAddressKey,
        selfieKey: data.selfieKey,
        status: 'PENDING',
      },
      update: {
        legalName: data.legalName,
        dob,
        address: data.address,
        idType: data.idType,
        idNumber: data.idNumber,
        idFrontKey: data.idFrontKey,
        idBackKey: data.idBackKey ?? null,
        proofOfAddressKey: data.proofOfAddressKey,
        selfieKey: data.selfieKey,
        status: 'PENDING',
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
      },
    }),
    prisma.user.update({ where: { id: userId }, data: { kycStatus: 'PENDING' } }),
  ]);

  await recordAudit({
    action: existing ? AUDIT.KYC_RESUBMITTED : AUDIT.KYC_SUBMITTED,
    userId,
    ipAddress: ip,
    details: {
      kycProfileId: profile.id,
      idType: data.idType,
      // Object keys are deliberately not written to the audit trail.
      documentKinds: KYC_DOCUMENT_KINDS.filter((kind) => Boolean(documentKeyFor(profile, kind))),
      resubmission: Boolean(existing),
      previousStatus: existing ? existing.status : null,
    },
  });

  return toKycProfileDto(profile);
}

/**
 * Document keys are namespaced `kyc/<userId>/...` by the uploader. Anything in
 * our own namespace that belongs to a different user is refused so a submission
 * cannot point a reviewer at somebody else's identity documents.
 */
function assertKeyBelongsToUser(key: string, userId: string, field: string): void {
  if (!key.startsWith('kyc/')) return;
  const owner = key.slice('kyc/'.length).split('/')[0];
  if (owner && owner !== userId) {
    throw ApiError.badRequest(`${field} does not belong to your account.`);
  }
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

export interface KycObjectKeys {
  idFrontKey: string;
  idBackKey: string | null;
  proofOfAddressKey: string;
  selfieKey: string;
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
  /** Which document slots are filled — safe for any reviewer role. */
  documents: { kind: string; uploaded: boolean }[];
  /**
   * Raw private-bucket object keys. SERVER-SIDE ONLY: the keys are returned
   * when the caller is server-side (role omitted) or an ADMIN, and they must
   * never be serialised straight into a response. A browser receives signed
   * URLs from getKycDocumentUrls() instead.
   */
  keys: KycObjectKeys | null;
}

/**
 * Full review payload for one submission.
 *
 * @param viewerRole when supplied, raw object keys are only included for
 *                   ADMIN — a TRADING_MANAGER sees the file without them.
 */
export async function getKycDetail(id: string, viewerRole?: Role): Promise<KycDetail> {
  const profile = await prisma.kycProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, fullName: true, country: true } } },
  });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const maySeeKeys = viewerRole === undefined || viewerRole === 'ADMIN';
  const documents = KYC_DOCUMENT_KINDS.map((kind) => ({
    kind: kind as string,
    uploaded: Boolean(documentKeyFor(profile, kind)),
  }));

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
    keys: maySeeKeys
      ? {
          idFrontKey: profile.idFrontKey,
          idBackKey: profile.idBackKey ?? null,
          proofOfAddressKey: profile.proofOfAddressKey,
          selfieKey: profile.selfieKey,
        }
      : null,
  };
}

/** Everything a review UI needs — with the raw object keys removed. */
export type KycDetailClientView = Omit<KycDetail, 'keys'> & {
  /** Where the 300-second signed URLs come from. */
  signedUrlEndpoint: string;
};

/** Strip the raw keys before a detail payload leaves the server. */
export function toKycDetailClientView(detail: KycDetail): KycDetailClientView {
  const { keys: _rawObjectKeys, ...safe } = detail;
  return {
    ...safe,
    signedUrlEndpoint: `/api/v1/admin/kyc/${detail.id}/files`,
  };
}

/* -------------------------------------------------------------------------- */
/* Admin: private document access                                              */
/* -------------------------------------------------------------------------- */

export interface KycDocumentUrlEntry {
  kind: string;
  /** Pre-signed GET URL, or null when the object is gone / could not be signed. */
  url: string | null;
  expiresInSeconds: number;
  error?: string;
}

/**
 * Mint short-lived review URLs for every stored document.
 *
 * ACCESS TRAIL: this is the only path that can reveal a private identity
 * document, so every call — successful or not — writes KYC_DOCUMENT_VIEWED with
 * the reviewer's user id and the document kinds involved. A failure to sign one
 * document is reported inline instead of failing the whole request, so a single
 * lost object cannot block the review of the others.
 */
export async function getKycDocumentUrls(
  id: string,
  adminUserId: string,
  ip: string | null = null,
): Promise<KycDocumentUrlEntry[]> {
  if (!adminUserId || !adminUserId.trim()) {
    throw ApiError.forbidden('A reviewer identity is required to open KYC documents.');
  }

  const profile = await prisma.kycProfile.findUnique({ where: { id } });
  if (!profile) throw ApiError.notFound('KYC profile not found.');

  const expiresInSeconds = resolveSignedUrlTtl();
  const stored = KYC_DOCUMENT_KINDS.flatMap((kind) => {
    const key = documentKeyFor(profile, kind);
    return key ? [{ kind: kind as string, key }] : [];
  });

  const entries: KycDocumentUrlEntry[] = [];
  for (const doc of stored) {
    try {
      const state = await getKycDocumentState(doc.key);
      if (state === 'missing') {
        entries.push({
          kind: doc.kind,
          url: null,
          expiresInSeconds,
          error: 'This document is no longer present in storage.',
        });
        continue;
      }
      const url = await getSignedDocumentUrl(doc.key, expiresInSeconds);
      entries.push({ kind: doc.kind, url, expiresInSeconds });
    } catch (err) {
      console.error(
        '[kyc] failed to sign document url:',
        err instanceof Error ? err.message : 'unknown error',
      );
      entries.push({
        kind: doc.kind,
        url: null,
        expiresInSeconds,
        error: 'A signed URL could not be generated for this document.',
      });
    }
  }

  const signedDocumentKinds = entries.filter((e) => e.url !== null).map((e) => e.kind);
  const failedDocumentKinds = entries.filter((e) => e.url === null).map((e) => e.kind);

  await recordAudit({
    action: AUDIT.KYC_DOCUMENT_VIEWED,
    userId: adminUserId,
    ipAddress: ip,
    details: {
      kycProfileId: profile.id,
      targetUserId: profile.userId,
      documentKinds: stored.map((doc) => doc.kind),
      signedDocumentKinds,
      failedDocumentKinds,
      expiresInSeconds,
    },
  });

  return entries;
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

  return toKycProfileDto(updated);
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

  return toKycProfileDto(updated);
}
