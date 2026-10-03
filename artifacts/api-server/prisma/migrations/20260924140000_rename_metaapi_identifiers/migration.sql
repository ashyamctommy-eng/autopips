-- Rename the MetaApi-era identifiers to the broker integration that actually
-- exists (Deriv). The MetaApi bridge was removed in 20260924130000's parent
-- change; only the names outlived it.
--
-- PURE RENAMES. No column is dropped or recreated and no row is touched:
-- production holds broker connections and trade records whose position ids are
-- the join key used by the settlement path, so a drop-and-add would be a data
-- loss dressed up as a rename.
--
-- Deliberately NOT renamed, because they are not identifiers in the schema:
--   * the Redis key prefix `ap:broker-token:<accountId>` — renaming it would
--     orphan every stored (encrypted) token;
--   * the credential-cipher purpose string 'metaapi' — it is an input to key
--     derivation, so renaming it would make existing ciphertext undecryptable.

ALTER TABLE "BrokerConnection" RENAME COLUMN "metaApiAccountId" TO "derivAccountId";
ALTER INDEX "BrokerConnection_metaApiAccountId_key" RENAME TO "BrokerConnection_derivAccountId_key";

ALTER TABLE "TradeRecord" RENAME COLUMN "metaApiPositionId" TO "derivContractId";
ALTER INDEX "TradeRecord_brokerId_metaApiPositionId_key" RENAME TO "TradeRecord_brokerId_derivContractId_key";
