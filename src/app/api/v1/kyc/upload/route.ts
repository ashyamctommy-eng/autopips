import { ApiError, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireSessionUser } from '@/server/modules/auth/session';
import {
  assertValidKycDocument,
  uploadKycDocument,
  type KycDocumentKind,
} from '@/server/modules/kyc/storage.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/kyc/upload — multipart/form-data.
 *
 * Streams the four review documents into the PRIVATE KYC bucket and returns
 * their object keys. The client then submits those keys with the rest of the
 * form via POST /api/v1/kyc/submit.
 *
 * The bucket is never public and this route never returns a URL — a document
 * can only be read through GET /api/v1/admin/kyc/:id/files, which mints
 * 300-second signed URLs for an ADMIN and audits every access.
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
): Promise<string | null> {
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

  // Type + size allow-list is enforced here, before a single byte is uploaded;
  // uploadKycDocument re-checks so the rule cannot be bypassed by another caller.
  assertValidKycDocument({ contentType, byteLength: bytes.byteLength });

  return uploadKycDocument({ userId, kind: field, filename: value.name, contentType, bytes });
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

  const idFrontKey = await storeField(form, 'idFront', user.id, true);
  const idBackKey = await storeField(form, 'idBack', user.id, false);
  const proofOfAddressKey = await storeField(form, 'proofOfAddress', user.id, true);
  const selfieKey = await storeField(form, 'selfie', user.id, true);

  return ok({ idFrontKey, idBackKey, proofOfAddressKey, selfieKey });
});
