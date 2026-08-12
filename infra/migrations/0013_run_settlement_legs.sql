BEGIN;

-- A run's money movement is a sequence of steps on possibly different chains: bridge out, land on
-- the destination, pay the target. Migration 0011 modelled this as nine bridge-specific columns on
-- orchestrator_run_checkpoints, which only fits exactly one shape -- one bridge, one payment -- and
-- forces a schema change for every new rail. It also cannot describe a prefunded run, which has a
-- payment and no bridge at all.
--
-- This table records those steps as ordered legs instead. Each leg is self-describing: which chain,
-- which asset, what it is doing, and how far it got. Adding a swap step, a second bridge provider,
-- or a different destination chain becomes a new row rather than new columns, and the dashboard can
-- render a run's progress without knowing which shape produced it.
CREATE TABLE run_settlement_legs (
  run_id text NOT NULL REFERENCES runs(id),
  -- Execution order within the run, 0-based. Also the display order.
  leg_index integer NOT NULL CHECK (leg_index >= 0),
  kind text NOT NULL CHECK (kind IN ('BRIDGE', 'TARGET_PAYMENT')),
  -- CAIP-2, e.g. 'eip155:56'. Text rather than an integer so a non-EVM rail needs no migration.
  network text NOT NULL CHECK (network ~ '^[a-z0-9-]+:[a-zA-Z0-9_-]+$'),
  asset_symbol text NOT NULL CHECK (length(asset_symbol) BETWEEN 1 AND 32),
  asset_decimals smallint NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
  asset_address bytea CHECK (asset_address IS NULL OR octet_length(asset_address) = 20),
  status text NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
  -- The chain transaction this leg produced, once it has one. A leg may confirm without its own
  -- transaction hash (an x402 authorization is settled by the facilitator, not by us).
  transaction_hash bytea CHECK (transaction_hash IS NULL OR octet_length(transaction_hash) = 32),
  amount_atomic numeric(78, 0) CHECK (amount_atomic IS NULL OR amount_atomic >= 0),
  -- Free-form provider label ('STARGATE_V2_LAYERZERO', an x402 facilitator name) for display only.
  provider text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, leg_index),
  -- A confirmed leg has to say how much moved; an unfinished one legitimately does not know yet.
  CHECK (status <> 'CONFIRMED' OR amount_atomic IS NOT NULL)
);

CREATE INDEX run_settlement_legs_run_idx ON run_settlement_legs (run_id, leg_index);

COMMIT;
