ALTER TABLE "TradeRecord"
  ADD COLUMN "strategyId" TEXT,
  ADD COLUMN "executionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "executionCompletedAt" TIMESTAMP(3),
  ADD COLUMN "executionLatencyMs" INTEGER;

CREATE INDEX "TradeRecord_status_strategyId_closedAt_idx"
  ON "TradeRecord"("status", "strategyId", "closedAt");

CREATE INDEX "TradeRecord_executionCompletedAt_idx"
  ON "TradeRecord"("executionCompletedAt");