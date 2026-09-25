-- Broker notional exposure, stored explicitly.
--
-- WHY: `volume` means LOTS for an MT5-style broker and the STAKE for a
-- stake-denominated one (Deriv multipliers). The open-exposure metric is
-- SUM(volume × entryPrice), which is correct for lots — but for a multiplier
-- contract the exposure is stake × multiplier, so volume × price overstates it
-- by a factor of the entry price (a $100 stake on gold at 4270 would read as
-- $427,000 instead of the $10,000 at 100x). Rather than overload `volume` with a
-- second meaning, the broker's own notional is stored here.
--
-- NULL is meaningful and expected: it means "this broker/position does not
-- define a notional", and the metric falls back to volume × entryPrice.

ALTER TABLE "TradeRecord" ADD COLUMN "notional" DECIMAL(18,2);
