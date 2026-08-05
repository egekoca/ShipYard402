BEGIN;

ALTER TABLE orchestrator_run_checkpoints
  ADD COLUMN refund_transaction_hash bytea
    CHECK (refund_transaction_hash IS NULL OR octet_length(refund_transaction_hash) = 32);

COMMIT;
