-- Legal documents + per-client consent records.
--
-- The platform captured no proof that a client accepted the terms, the privacy
-- policy or the risk disclosure, and the published instruments were not
-- versioned. This adds:
--
--   * `LegalDocument` — one immutable row per revision. A new revision is a new
--     ROW, never an edit, and `contentHash` (SHA-256 of the exact text served)
--     makes the record verifiable rather than merely declarative.
--   * `UserConsent`   — who accepted which document version, when, and from
--     where. `unique(userId, documentId)` makes re-accepting the same version a
--     no-op while accepting a new version still appends history.
--
-- Both tables are additive; no existing column is touched and no table is
-- dropped.

-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'RISK_DISCLOSURE');

-- CreateTable
CREATE TABLE "LegalDocument" (
    "id" TEXT NOT NULL,
    "type" "LegalDocumentType" NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentType" "LegalDocumentType" NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "method" TEXT NOT NULL,

    CONSTRAINT "UserConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_type_version_key" ON "LegalDocument"("type", "version");

-- CreateIndex
CREATE INDEX "LegalDocument_type_effectiveFrom_idx" ON "LegalDocument"("type", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "UserConsent_userId_documentId_key" ON "UserConsent"("userId", "documentId");

-- CreateIndex
CREATE INDEX "UserConsent_userId_acceptedAt_idx" ON "UserConsent"("userId", "acceptedAt");

-- CreateIndex
CREATE INDEX "UserConsent_documentType_documentVersion_idx" ON "UserConsent"("documentType", "documentVersion");

-- AddForeignKey
ALTER TABLE "UserConsent" ADD CONSTRAINT "UserConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserConsent" ADD CONSTRAINT "UserConsent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LegalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
