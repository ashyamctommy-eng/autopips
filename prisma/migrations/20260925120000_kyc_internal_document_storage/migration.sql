-- KYC documents move INSIDE the platform.
--
-- Before: `KycProfile` held four opaque object keys (idFrontKey, idBackKey,
-- proofOfAddressKey, selfieKey) pointing at a private AWS S3 bucket, and a
-- reviewer read the files through 300-second pre-signed URLs. That required an
-- external service and an object-storage credential, and it is the reason KYC
-- upload returned 500 in production (the AWS_* variables were never usable).
--
-- After: the document BYTES live in `KycDocument.ciphertext`, encrypted at rest
-- with AES-256-GCM, and are served only through an ADMIN-authenticated route
-- that audits every read. Two slots remain — the front and back of one identity
-- document; the liveness/selfie slot and the proof-of-address slot are gone.
--
-- The dropped columns held object keys, not document bytes, so no *document* is
-- lost here — but this migration IS irreversible for them: take a snapshot
-- (`pg_dump`) before running it on a database that may hold key values you want
-- to keep. Nothing in the application reads these columns any more (verified
-- across src/, tests/, scripts/, .github/ and the deploy configs), and any
-- `KycProfile` row that survives will simply have no `KycDocument` rows until the
-- client submits again.

-- AlterTable
ALTER TABLE "KycProfile" DROP COLUMN "idBackKey",
DROP COLUMN "idFrontKey",
DROP COLUMN "proofOfAddressKey",
DROP COLUMN "selfieKey";

-- CreateTable
CREATE TABLE "KycDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycDocument_profileId_idx" ON "KycDocument"("profileId");

-- CreateIndex
CREATE INDEX "KycDocument_userId_idx" ON "KycDocument"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "KycDocument_userId_kind_key" ON "KycDocument"("userId", "kind");

-- AddForeignKey
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "KycProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
