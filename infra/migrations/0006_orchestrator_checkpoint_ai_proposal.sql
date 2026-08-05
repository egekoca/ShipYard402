BEGIN;

ALTER TABLE orchestrator_run_checkpoints
  ADD COLUMN ai_proposal jsonb;

COMMIT;
