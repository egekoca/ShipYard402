BEGIN;

CREATE TABLE orchestrator_run_checkpoints (
  run_id text PRIMARY KEY REFERENCES runs(id),
  risk_level text,
  scenarios jsonb,
  tool_budget_atomic numeric(78, 0),
  rationale text,
  payment_transaction_hash bytea CHECK (payment_transaction_hash IS NULL OR octet_length(payment_transaction_hash) = 32),
  purchase_receipt text,
  evidence jsonb,
  started_at bigint,
  completed_at bigint,
  attestation_transaction_hash bytea CHECK (attestation_transaction_hash IS NULL OR octet_length(attestation_transaction_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scenarios IS NULL) = (risk_level IS NULL)),
  CHECK ((started_at IS NULL) = (evidence IS NULL)),
  CHECK ((completed_at IS NULL) = (evidence IS NULL))
);

COMMIT;
