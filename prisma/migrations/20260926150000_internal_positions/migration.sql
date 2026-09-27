-- Internally-executed positions (EXECUTION_MODE=internal).
--
-- The platform becomes the counterparty, so a position is NOT a broker object.
-- `stake` is the money at risk and the MAXIMUM loss (the same doctrine the
-- managed-trading path settled): `multiplier` turns the stake into an exposure,
-- and P&L is clamped at −stake in the engine.
--
-- The ledger stays the single source of money truth: an OPEN position's stake
-- joins DEPLOYED capital and its pnl joins UNREALIZED P/L; a CLOSED position's
-- pnl joins REALIZED P/L and releases the stake to idle cash. No balance column
-- is added anywhere.
--
-- Additive and safe on a populated database: new enum types, one new table, no
-- change to any existing column.

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "PositionSide" NOT NULL,
    "stake" DECIMAL(18,2) NOT NULL,
    "multiplier" DECIMAL(18,2) NOT NULL DEFAULT 1.00,
    "entryPrice" DECIMAL(18,5) NOT NULL,
    "currentPrice" DECIMAL(18,5) NOT NULL,
    "stopLoss" DECIMAL(18,5),
    "takeProfit" DECIMAL(18,5),
    "pnl" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "executionMode" TEXT NOT NULL DEFAULT 'INTERNAL',
    "closePrice" DECIMAL(18,5),
    "closedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Position_userId_status_idx" ON "Position"("userId", "status");

-- CreateIndex
CREATE INDEX "Position_symbol_status_idx" ON "Position"("symbol", "status");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
