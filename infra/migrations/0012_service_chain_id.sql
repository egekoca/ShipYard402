BEGIN;

-- A listed service settles on a specific chain, and the marketplace now lets a person filter the
-- directory by chain. Until this column existed every listing was implicitly GOAT Testnet3 (the one
-- deployment that had onboarding), so that is the backfill default for existing rows and the default
-- for newly onboarded ones until cross-chain onboarding sets it explicitly.
ALTER TABLE services
  ADD COLUMN chain_id bigint NOT NULL DEFAULT 48816;

-- Only listed rows are ever filtered on chain; scope the index to them.
CREATE INDEX services_marketplace_chain_idx
  ON services (chain_id, marketplace_rank, created_at)
  WHERE marketplace_listed AND active;

COMMIT;
