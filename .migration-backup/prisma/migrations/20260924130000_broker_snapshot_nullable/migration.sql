-- A broker that does not report a figure must be able to say so.
--
-- Deriv reports balance (and equity, derivable from balance + open contract
-- profit) but has no free margin concept at all, and before an API token is
-- authorised it reports nothing. Writing 0 into these columns would read as a
-- real, empty balance, so they become nullable and the UI renders "—".
ALTER TABLE "BrokerConnection" ALTER COLUMN "balance" DROP NOT NULL;
ALTER TABLE "BrokerConnection" ALTER COLUMN "equity" DROP NOT NULL;
ALTER TABLE "BrokerConnection" ALTER COLUMN "freeMargin" DROP NOT NULL;
