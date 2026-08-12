BEGIN;

ALTER TABLE orchestrator_run_checkpoints
  ADD COLUMN payment_header_name text
    CHECK (payment_header_name IS NULL OR payment_header_name IN ('x-payment', 'payment-signature')),
  ADD COLUMN bridge_provider text,
  ADD COLUMN bridge_transfer_id text,
  ADD COLUMN bridge_source_transaction_hash bytea
    CHECK (bridge_source_transaction_hash IS NULL OR octet_length(bridge_source_transaction_hash) = 32),
  ADD COLUMN bridge_submitted_at bigint,
  ADD COLUMN bridge_destination_transaction_hash bytea
    CHECK (bridge_destination_transaction_hash IS NULL OR octet_length(bridge_destination_transaction_hash) = 32),
  ADD COLUMN bridge_amount_received_atomic numeric(78, 0),
  ADD COLUMN target_payment_transaction_hash bytea
    CHECK (target_payment_transaction_hash IS NULL OR octet_length(target_payment_transaction_hash) = 32),
  ADD COLUMN target_payment_amount_atomic numeric(78, 0);

CREATE TABLE bridge_submissions (
  idempotency_key text PRIMARY KEY,
  quote_id text NOT NULL,
  run_id text NOT NULL REFERENCES runs(id),
  destination_payer bytea NOT NULL CHECK (octet_length(destination_payer) = 20),
  minimum_amount_out_atomic numeric(78, 0) NOT NULL CHECK (minimum_amount_out_atomic > 0),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'SUBMITTED')),
  source_transaction_hash bytea
    CHECK (source_transaction_hash IS NULL OR octet_length(source_transaction_hash) = 32),
  transfer_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'CLAIMED' AND source_transaction_hash IS NULL AND transfer_id IS NULL)
    OR
    (status = 'SUBMITTED' AND source_transaction_hash IS NOT NULL AND transfer_id IS NOT NULL)
  )
);

CREATE TABLE bnb_x402_authorizations (
  idempotency_key text PRIMARY KEY,
  amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'AUTHORIZED')),
  payment_receipt text,
  payment_proof_hash bytea
    CHECK (payment_proof_hash IS NULL OR octet_length(payment_proof_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'CLAIMED' AND payment_receipt IS NULL AND payment_proof_hash IS NULL)
    OR
    (status = 'AUTHORIZED' AND payment_receipt IS NOT NULL AND payment_proof_hash IS NOT NULL)
  )
);

COMMIT;
