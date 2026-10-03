import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/lib/prisma';
import {
  currentLegalDocuments,
  type CurrentLegalDocument,
  type LegalDocumentTypeValue,
} from './legal.documents';

/**
 * Legal-consent persistence.
 *
 * The document TEXT lives in `legal.documents.ts` (pure, no database) because
 * the public `/terms`, `/privacy` and `/risk` pages render it. This module owns
 * the two database concerns:
 *
 *   • publishing a revision into `LegalDocument` (idempotent, append-only);
 *   • recording a client's acceptance into `UserConsent`, with the version, the
 *     content hash, the time, the IP and the user-agent — the evidence a
 *     regulator or a dispute asks for.
 *
 * The public API of the pure module is re-exported here so existing callers can
 * keep importing from `legal.service` if they prefer.
 */

export {
  CURRENT_LEGAL_DOCUMENTS,
  canonicalDocumentText,
  currentLegalDocuments,
  findCurrentDocument,
  legalContentHash,
} from './legal.documents';
export type {
  CurrentLegalDocument,
  LegalDocumentDefinition,
  LegalDocumentTypeValue,
} from './legal.documents';

type LegalDb = Prisma.TransactionClient;

export interface PublishedDocumentRef {
  id: string;
  version: string;
  contentHash: string;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Publish ONE revision, tolerating a concurrent first-time insert.
 *
 * Prisma's `upsert` is not always a native `INSERT … ON CONFLICT` (the empty
 * `update` makes it emulated in some versions), so two concurrent registrations
 * on a cold start can collide on `LegalDocument_type_version_key`. The row exists
 * either way — read it back instead of failing a signup over bookkeeping.
 */
async function publishDocument(
  db: LegalDb,
  doc: CurrentLegalDocument,
): Promise<PublishedDocumentRef> {
  const where = { type_version: { type: doc.type, version: doc.version } } as const;
  const select = { id: true, version: true, contentHash: true } as const;

  try {
    const row = await db.legalDocument.upsert({
      where,
      create: {
        type: doc.type,
        version: doc.version,
        title: doc.title,
        url: doc.url,
        contentHash: doc.contentHash,
        effectiveFrom: new Date(`${doc.effectiveFrom}T00:00:00.000Z`),
      },
      // Deliberately empty: publishing is append-only, so a re-run can never
      // rewrite what an existing consent refers to.
      update: {},
      select,
    });
    return { id: row.id, version: row.version, contentHash: row.contentHash };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.legalDocument.findUnique({ where, select });
      if (existing) {
        return { id: existing.id, version: existing.version, contentHash: existing.contentHash };
      }
    }
    throw err;
  }
}

/**
 * Publish (idempotently) the current document revisions and return their row ids.
 *
 * An existing row is NEVER updated: a revision is a new version, and rewriting
 * the hash of a version someone already accepted would invalidate that record.
 * Takes the transaction client explicitly — publishing and consent capture must
 * share the same transaction as the account insert.
 */
export async function ensureLegalDocumentsPublished(
  db: LegalDb,
): Promise<Map<LegalDocumentTypeValue, PublishedDocumentRef>> {
  const published = new Map<LegalDocumentTypeValue, PublishedDocumentRef>();

  for (const doc of currentLegalDocuments()) {
    published.set(doc.type, await publishDocument(db, doc));
  }

  return published;
}

export interface ConsentCaptureContext {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  method: string;
}

/**
 * Record acceptance of EVERY current document for a user, in one call.
 *
 * `skipDuplicates` makes re-accepting the SAME version a no-op while a NEW
 * version still appends a row, so the full consent history survives. Must be
 * called inside the same transaction that creates the account.
 */
export async function recordCurrentConsents(
  db: LegalDb,
  context: ConsentCaptureContext,
  options: { requireAll?: boolean } = {},
): Promise<number> {
  const published = await ensureLegalDocumentsPublished(db);

  const rows = currentLegalDocuments().map((doc) => {
    const ref = published.get(doc.type);
    if (!ref) throw new Error(`Legal document ${doc.type} was not published.`);
    return {
      userId: context.userId,
      documentId: ref.id,
      documentType: doc.type,
      documentVersion: doc.version,
      contentHash: ref.contentHash,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      method: context.method,
    };
  });

  const inserted = await db.userConsent.createMany({ data: rows, skipDuplicates: true });

  // On a first-time capture every row must land; `skipDuplicates` exists so a
  // RE-consent of the same version is a no-op, not so a partial registration can
  // commit. Throwing here aborts the surrounding transaction.
  if (options.requireAll && inserted.count !== rows.length) {
    throw new Error(
      `Consent capture incomplete: expected ${rows.length} rows, wrote ${inserted.count}.`,
    );
  }

  return inserted.count;
}

/** Every consent a user has given, newest first. */
export async function listUserConsents(userId: string) {
  return prisma.userConsent.findMany({
    where: { userId },
    orderBy: { acceptedAt: 'desc' },
    select: {
      id: true,
      documentType: true,
      documentVersion: true,
      contentHash: true,
      acceptedAt: true,
      method: true,
    },
  });
}

/**
 * True when the user has an acceptance for EVERY current document version. Used
 * to decide whether a re-consent prompt is required after a version bump.
 */
export async function hasAcceptedCurrentDocuments(userId: string): Promise<boolean> {
  const rows = await prisma.userConsent.findMany({
    where: { userId },
    select: { documentType: true, documentVersion: true },
  });
  const accepted = new Set(rows.map((row) => `${row.documentType}:${row.documentVersion}`));
  return currentLegalDocuments().every((doc) => accepted.has(`${doc.type}:${doc.version}`));
}
