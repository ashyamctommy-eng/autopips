-- P0 money-path schema.
--
-- Three gaps, one migration, all of them additive and nullable so it is safe on a
-- populated production database (no NOT NULL column without a default is added to
-- a table that already has rows).
--
-- 1. Withdrawal — a payout could not be reconciled at all. The provider's payout
--    id was written to the audit log and nowhere else, so once the HTTP call
--    returned there was no way to look the payout up again; and `amountUsd` (USD)
--    was sent to the provider as the COIN amount, which orders 100 BTC for a $100
--    withdrawal. `payAmount` records the coin figure actually broadcast,
--    `providerPayoutId`/`providerStatus` make reconciliation possible,
--    `secondApprovedBy` is the two-person control, and `settledAt` separates
--    "provider accepted" from "funds actually left".
--
-- 2. Investment — an investment could never leave ACTIVE/PAUSED, so a client's
--    principal was locked forever. `closedAt` is the terminal timestamp and the
--    `maturityDate` index serves the sweep that finds matured investments.
--
-- 3. Investment — the performance-fee high-water mark lived only in Redis, so a
--    flush or eviction reset it to the starting capital and the platform would
--    re-charge performance on profit it had already taken a fee on.
--    `peakEquityUsd` is the durable copy; `lastFeeAt` is the fee-period anchor that
--    makes accrual idempotent across restarts.
-- AlterTable
ALTER TABLE "Investment" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "lastFeeAt" TIMESTAMP(3),
ADD COLUMN     "peakEquityUsd" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "ipnPayload" JSONB,
ADD COLUMN     "payAmount" DECIMAL(18,8),
ADD COLUMN     "providerPayoutId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "secondApprovedBy" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Investment_maturityDate_idx" ON "Investment"("maturityDate");

-- CreateIndex
CREATE INDEX "Withdrawal_providerPayoutId_idx" ON "Withdrawal"("providerPayoutId");

-- CreateIndex
CREATE INDEX "Withdrawal_createdAt_idx" ON "Withdrawal"("createdAt");

