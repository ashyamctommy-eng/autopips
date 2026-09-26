-- Durable single-use claims (replay / idempotency guard).
--
-- Money-critical claims (deposit IPN delivery slots, payout IPN slots, trade
-- signals) used to live ONLY in Redis. Redis is evictable, flushable and can be
-- down, and both failure modes moved real money:
--
--   * Redis DOWN  → `claimOnce` failed closed, so a signature-valid deposit
--     callback was answered 200 as a "duplicate" and the credit was dropped.
--   * Redis FLUSH → the claim vanished, so a re-delivered signal could place a
--     second live broker order.
--
-- Postgres becomes the authority for "has this already happened"; Redis stays as
-- an accelerator in front of it. `expiresAt` bounds the table (a claim is
-- meaningful for at most a day); rows are swept lazily when the same key is
-- claimed again.
--
-- CreateTable
CREATE TABLE "IdempotencyClaim" (
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyClaim_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "IdempotencyClaim_expiresAt_idx" ON "IdempotencyClaim"("expiresAt");
