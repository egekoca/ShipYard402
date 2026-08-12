BEGIN;

-- Which chain a run's target settles on has, until now, existed only in the services catalog. The
-- quote -- the run's binding contract -- did not carry it, so the orchestrator had no way to tell
-- that a selected target was on another chain and fell back to paying it on the funding chain.
--
-- Recording it on the quote also freezes it: a service owner editing services.chain_id afterwards
-- must not be able to redirect an already-quoted run's payment to a different chain.
ALTER TABLE quotes ADD COLUMN target_chain_id bigint;

-- Backfilled from each quote's own service rather than a constant, so the value is the real one
-- rather than an assumption. Every existing service is on GOAT Testnet3, so this is exact.
UPDATE quotes q
   SET target_chain_id = s.chain_id
  FROM services s
 WHERE s.id = q.service_id;

ALTER TABLE quotes
  ALTER COLUMN target_chain_id SET NOT NULL,
  ADD CONSTRAINT quotes_target_chain_id_check CHECK (target_chain_id > 0);

COMMIT;
