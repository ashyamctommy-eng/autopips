ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
CREATE TABLE "WalletAdjustment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "actorId" TEXT NOT NULL REFERENCES "User"("id"),
  "amount" DECIMAL(18,2) NOT NULL CHECK ("amount" <> 0),
  "type" TEXT NOT NULL DEFAULT 'ADMIN_ADJUSTMENT' CHECK ("type" = 'ADMIN_ADJUSTMENT'),
  "status" TEXT NOT NULL DEFAULT 'completed' CHECK ("status" = 'completed'),
  "description" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WalletAdjustment_userId_createdAt_idx" ON "WalletAdjustment"("userId", "createdAt");