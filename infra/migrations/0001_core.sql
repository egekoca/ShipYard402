BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE run_status AS ENUM (
  'DRAFT', 'QUOTED', 'PAYMENT_REQUIRED', 'FUNDED', 'ANALYZING',
  'PLAN_COMPILED', 'PROCURING', 'EXECUTING', 'REPLANNING',
  'EVIDENCE_BUILDING', 'ATTESTING', 'DELIVERED_PASS',
  'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE',
  'CANCELLED', 'EXPIRED'
);

CREATE TYPE run_result AS ENUM ('PASS', 'CONDITIONAL', 'FAIL', 'INCONCLUSIVE');
CREATE TYPE payment_direction AS ENUM ('CUSTOMER_IN', 'TOOL_OUT', 'TARGET_CANARY_OUT', 'REFUND_OUT');
CREATE TYPE ledger_category AS ENUM (
  'CUSTOMER_PAYMENT', 'CUSTOMER_REFUND', 'TOOL_SPEND',
  'MODEL_COST', 'CHAIN_COST', 'STORAGE_COST'
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  billing_wallet bytea NOT NULL CHECK (octet_length(billing_wallet) = 20),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  erc8004_agent_id numeric(78, 0),
  external_service_id text NOT NULL,
  name text NOT NULL,
  x402_endpoint text NOT NULL,
  openapi_url text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_service_id)
);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  version text NOT NULL,
  version_hash bytea NOT NULL CHECK (octet_length(version_hash) = 32),
  previous_version_hash bytea CHECK (previous_version_hash IS NULL OR octet_length(previous_version_hash) = 32),
  manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
  deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, version_hash)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  policy_hash bytea NOT NULL UNIQUE CHECK (octet_length(policy_hash) = 32),
  mandatory_scenarios jsonb NOT NULL,
  mandate_template jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE quotes (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  service_id uuid NOT NULL REFERENCES services(id),
  release_id uuid NOT NULL REFERENCES releases(id),
  policy_id uuid NOT NULL REFERENCES policies(id),
  requester bytea NOT NULL CHECK (octet_length(requester) = 20),
  request_snapshot jsonb NOT NULL,
  capability_snapshot jsonb NOT NULL,
  line_items jsonb NOT NULL,
  payment_chain_id bigint NOT NULL,
  payment_token bytea NOT NULL CHECK (octet_length(payment_token) = 20),
  total_atomic_amount numeric(78, 0) NOT NULL CHECK (total_atomic_amount > 0),
  refundable_tool_budget_atomic numeric(78, 0) NOT NULL CHECK (refundable_tool_budget_atomic >= 0),
  pricing_status text NOT NULL CHECK (pricing_status = 'HYPOTHESIS'),
  quote_commitment bytea NOT NULL UNIQUE CHECK (octet_length(quote_commitment) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);

CREATE TABLE runs (
  id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES quotes(id),
  service_id uuid NOT NULL REFERENCES services(id),
  release_id uuid NOT NULL REFERENCES releases(id),
  policy_id uuid NOT NULL REFERENCES policies(id),
  request_idempotency_key text NOT NULL UNIQUE,
  requester bytea NOT NULL CHECK (octet_length(requester) = 20),
  status run_status NOT NULL,
  result run_result,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  mandate jsonb,
  customer_payment_atomic numeric(78, 0) CHECK (customer_payment_atomic >= 0),
  actual_tool_spend_atomic numeric(78, 0) NOT NULL DEFAULT 0 CHECK (actual_tool_spend_atomic >= 0),
  customer_payment_proof_hash bytea UNIQUE CHECK (
    customer_payment_proof_hash IS NULL OR octet_length(customer_payment_proof_hash) = 32
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (status IN ('DELIVERED_PASS', 'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE') AND result IS NOT NULL)
    OR
    (status NOT IN ('DELIVERED_PASS', 'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE') AND result IS NULL)
  )
);

CREATE TABLE run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES runs(id),
  revision bigint NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (run_id, revision),
  UNIQUE (run_id, idempotency_key)
);

CREATE TABLE payment_orders (
  run_id text PRIMARY KEY REFERENCES runs(id),
  order_id text NOT NULL UNIQUE,
  dapp_order_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN (
    'CHECKOUT_VERIFIED', 'PAYMENT_CONFIRMED', 'INVOICED',
    'FAILED', 'EXPIRED', 'CANCELLED'
  )),
  chain_id bigint NOT NULL,
  token bytea NOT NULL CHECK (octet_length(token) = 20),
  payer bytea NOT NULL CHECK (octet_length(payer) = 20),
  recipient bytea NOT NULL CHECK (octet_length(recipient) = 20),
  atomic_amount numeric(78, 0) NOT NULL CHECK (atomic_amount > 0),
  expires_at timestamptz NOT NULL,
  order_snapshot jsonb NOT NULL,
  capability_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (run_id = dapp_order_id)
);

CREATE TABLE test_plans (
  run_id text PRIMARY KEY REFERENCES runs(id),
  risk_level text NOT NULL,
  ai_plan jsonb NOT NULL,
  compiled_plan jsonb NOT NULL,
  model_trace_hash bytea NOT NULL CHECK (octet_length(model_trace_hash) = 32),
  approved_at timestamptz NOT NULL
);

CREATE TABLE tool_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  erc8004_agent_id numeric(78, 0),
  external_agent_id text NOT NULL UNIQUE,
  endpoint_origin text NOT NULL,
  capability text NOT NULL,
  receipt_signer bytea NOT NULL CHECK (octet_length(receipt_signer) = 20),
  pricing jsonb NOT NULL,
  allowlisted boolean NOT NULL DEFAULT false,
  first_party boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES runs(id),
  provider_id uuid NOT NULL REFERENCES tool_providers(id),
  idempotency_key text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  x402_order_id text,
  chain_id bigint NOT NULL,
  token bytea NOT NULL CHECK (octet_length(token) = 20),
  atomic_amount numeric(78, 0) NOT NULL CHECK (atomic_amount > 0),
  status text NOT NULL,
  payment_proof_hash bytea CHECK (payment_proof_hash IS NULL OR octet_length(payment_proof_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, idempotency_key),
  UNIQUE (x402_order_id)
);

CREATE TABLE payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES runs(id),
  tool_purchase_id uuid REFERENCES tool_purchases(id),
  direction payment_direction NOT NULL,
  order_id text NOT NULL,
  chain_id bigint NOT NULL,
  token bytea NOT NULL CHECK (octet_length(token) = 20),
  payer bytea NOT NULL CHECK (octet_length(payer) = 20),
  recipient bytea NOT NULL CHECK (octet_length(recipient) = 20),
  atomic_amount numeric(78, 0) NOT NULL CHECK (atomic_amount > 0),
  transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
  log_index integer NOT NULL CHECK (log_index >= 0),
  proof_hash bytea NOT NULL UNIQUE CHECK (octet_length(proof_hash) = 32),
  provider_payload jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  UNIQUE (chain_id, transaction_hash, log_index, direction)
);

CREATE TABLE scenario_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES runs(id),
  scenario_id text NOT NULL,
  tool_purchase_id uuid REFERENCES tool_purchases(id),
  result run_result NOT NULL CHECK (result IN ('PASS', 'FAIL', 'INCONCLUSIVE')),
  failure_code text,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_hash bytea NOT NULL CHECK (octet_length(response_hash) = 32),
  tool_receipt_hash bytea NOT NULL UNIQUE CHECK (octet_length(tool_receipt_hash) = 32),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, scenario_id)
);

CREATE TABLE evidence_packs (
  run_id text PRIMARY KEY REFERENCES runs(id),
  evidence_root bytea NOT NULL UNIQUE CHECK (octet_length(evidence_root) = 32),
  tool_receipt_root bytea NOT NULL CHECK (octet_length(tool_receipt_root) = 32),
  uri text NOT NULL,
  content_hash bytea NOT NULL UNIQUE CHECK (octet_length(content_hash) = 32),
  public_manifest jsonb NOT NULL,
  built_at timestamptz NOT NULL
);

CREATE TABLE attestations (
  run_id text PRIMARY KEY REFERENCES runs(id),
  registry_address bytea NOT NULL CHECK (octet_length(registry_address) = 20),
  chain_id bigint NOT NULL,
  transaction_hash bytea NOT NULL UNIQUE CHECK (octet_length(transaction_hash) = 32),
  attestor bytea NOT NULL CHECK (octet_length(attestor) = 20),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL
);

CREATE TABLE revenue_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES runs(id),
  category ledger_category NOT NULL,
  chain_id bigint NOT NULL,
  token bytea NOT NULL CHECK (octet_length(token) = 20),
  atomic_amount numeric(78, 0) NOT NULL CHECK (atomic_amount >= 0),
  accounting_currency text CHECK (accounting_currency = 'USD'),
  accounting_value_micros numeric(78, 0) CHECK (accounting_value_micros >= 0),
  valuation_source text,
  transaction_hash bytea CHECK (transaction_hash IS NULL OR octet_length(transaction_hash) = 32),
  external_reference text,
  occurred_at timestamptz NOT NULL,
  CHECK (
    (accounting_currency IS NULL AND accounting_value_micros IS NULL AND valuation_source IS NULL)
    OR
    (accounting_currency IS NOT NULL AND accounting_value_micros IS NOT NULL AND valuation_source IS NOT NULL)
  )
);

CREATE TABLE sentinel_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  policy_id uuid NOT NULL REFERENCES policies(id),
  cadence_seconds integer NOT NULL CHECK (cadence_seconds >= 60),
  maximum_canary_budget_atomic numeric(78, 0) NOT NULL CHECK (maximum_canary_budget_atomic > 0),
  next_run_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (service_id, policy_id)
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  detected_by_run_id text NOT NULL REFERENCES runs(id),
  severity text NOT NULL,
  status text NOT NULL,
  resolved_by_release_id uuid REFERENCES releases(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX runs_status_idx ON runs(status, updated_at);
CREATE INDEX run_events_run_idx ON run_events(run_id, revision);
CREATE INDEX payment_orders_status_idx ON payment_orders(status, updated_at);
CREATE INDEX tool_purchases_run_idx ON tool_purchases(run_id, status);
CREATE INDEX payment_receipts_run_idx ON payment_receipts(run_id, direction);
CREATE UNIQUE INDEX payment_receipts_customer_run_unique
  ON payment_receipts(run_id) WHERE direction = 'CUSTOMER_IN';
CREATE INDEX revenue_ledger_run_idx ON revenue_ledger(run_id, category);
CREATE INDEX sentinel_due_idx ON sentinel_subscriptions(next_run_at) WHERE active;
CREATE INDEX outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;

COMMIT;
