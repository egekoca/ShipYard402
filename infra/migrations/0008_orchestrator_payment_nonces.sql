BEGIN;

ALTER TABLE orchestrator_run_checkpoints
  ADD COLUMN payment_nonce integer,
  ADD COLUMN refund_nonce integer;

COMMIT;
