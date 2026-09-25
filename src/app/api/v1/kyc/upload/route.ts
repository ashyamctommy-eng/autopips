import { ApiError, clientIp, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser } from '@/server/modules/auth/session';
import {
  KYC_DOCUMENT_KINDS,
  assertValidKycDocument,
  findKycDocuments,
  uploadKycDocument,
  type KycDocumentKind,
  type UploadKycDocumentResult,
} from '@/server/modules/kyc/storage.service';
import { resetSubmissionAfterDocumentReplacement } from '@/server/modules/kyc/kyc.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/kyc/upload — multipart/form-data.
 *
 * Stores the identity documents INSIDE the platform: the bytes are encrypted
 * with AES-256-GCM and written to the `KycDocument` row for this user and slot
 * (see storage.service.ts). There is no bucket, no external service and no
 * pre-signed URL anywhere on this path.
 *
 * Two fields, one document: `idFront` (required) and `idBack` (the reverse side,
 * needed for anything but a passport). There is no liveness check and no selfie.
 *
 * The response carries the ROW IDS of whatever is on file after the write. An id
 * grants nothing on its own — the bytes are only readable through the
 * ADMIN-authenticated route `GET /api/v1/admin/kyc/:id/documents/:kind`, which
 * audits every read.
 */

/** 20 uploads a minute is far more than a reviewable submission needs. */
const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_RATE_WINDOW_SECONDS = 60;

interface UploadedFileLike {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFileLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

async function storeField(
  form: FormData,
  field: KycDocumentKind,
  userId: string,
  required: boolean,
): Promise<UploadKycDocumentResult | null> {
  const value = form.get(field);

  if (value === null || value === '') {
    if (required) throw ApiError.badRequest(`Missing required file field "${field}".`);
    return null;
  }
  if (!isUploadedFile(value)) {
    throw ApiError.badRequest(`Field "${field}" must be a file upload.`);
  }

  const contentType = value.type;
  const bytes = Buffer.from(await value.arrayBuffer());

  // Type + size allow-list is enforced here, before a byte is encrypted;
  // uploadKycDocument re-checks so the rule cannot be bypassed by another caller.
  assertValidKycDocument({ contentType, byteLength: bytes.byteLength });

  return uploadKycDocument({ userId, kind: field, contentType, bytes });
}

export const POST = handler(async (request: Request) => {
  const user = await requireSessionUser();

  const limit = await rateLimit(
    `kyc:upload:${user.id}`,
    UPLOAD_RATE_LIMIT,
    UPLOAD_RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    throw ApiError.rateLimited(
      `Too many document uploads. Try again in ${limit.resetSeconds} seconds.`,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw ApiError.badRequest('Request must be multipart/form-data.');
  }

  const [front, back] = await Promise.all([
    storeField(form, 'idFront', user.id, true),
    storeField(form, 'idBack', user.id, false),
  ]);

  /*
   * A replacement of a document that was already part of a submission leaves the
   * review (possibly an APPROVED one) describing bytes that no longer exist, so
   * the submission is put back to PENDING here — before the response goes out, so
   * the client cannot hold a verified status over a swapped file.
   */
  const replacedKinds: KycDocumentKind[] = [];
  if (front?.replacedAttachedProfileId) replacedKinds.push('idFront');
  if (back?.replacedAttachedProfileId) replacedKinds.push('idBack');

  const replacedProfileId = front?.replacedAttachedProfileId ?? back?.replacedAttachedProfileId ?? null;
  if (replacedProfileId !== null) {
    await resetSubmissionAfterDocumentReplacement({
      userId: user.id,
      profileId: replacedProfileId,
      kinds: replacedKinds,
      ip: clientIp(request),
    });
  }

  // Report the ids of what is on file NOW rather than only what this request
  // carried: a client replacing the front alone still learns the id of the stored
  // back side, which it must send back when it submits.
  const stored = await findKycDocuments(user.id, KYC_DOCUMENT_KINDS);

  return ok({
    idFrontDocumentId: stored.get('idFront')?.id ?? null,
    idBackDocumentId: stored.get('idBack')?.id ?? null,
    storedKinds: [...stored.keys()],
  });
});
