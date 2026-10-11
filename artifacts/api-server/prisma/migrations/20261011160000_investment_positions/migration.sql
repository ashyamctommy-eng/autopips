-- Link internally-executed positions to the Investment whose deployed capital
-- backs them (option (b): the bot engine trades the platform's own book against
-- client investments).
--
-- WHY THIS IS ADDITIVE AND NULLABLE ONLY
--   `Position` is already populated on live deployments. Both new columns are
--   NULL-able with no default, so every existing row keeps its meaning (an
--   unlinked, client-opened position) and the migration cannot fail on data.
--
-- MONEY CONTRACT (read before querying either table)
--   An investment-linked position is a BREAKDOWN of the investment's deployed
--   capital, not a second source of it. `accounting/ledger.ts` therefore
--   excludes rows with `investmentId IS NOT NULL` from its position aggregates:
--   the Investment row already carries that capital (`capitalUsd`) and P&L
--   (`realizedPnL` / `unrealizedPnL`). Counting both would double the client's
--   deployed capital and P/L. See `investment-execution.service.ts` for the
--   writer that keeps the Investment columns and the linked positions in step.
--
-- The index serves the engine's idempotency lookup
-- (`investmentId + status`) and the per-investment roll-up scan.

-- AlterTable
ALTER TABLE "Position" ADD COLUMN "investmentId" TEXT;
ALTER TABLE "Position" ADD COLUMN "strategyId" TEXT;

-- CreateIndex
CREATE INDEX "Position_investmentId_status_idx" ON "Position"("investmentId", "status");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
