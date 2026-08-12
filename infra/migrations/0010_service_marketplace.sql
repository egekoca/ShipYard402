BEGIN;

-- The catalog already held everything a quote needs to bind to a service (organization,
-- external_service_id, endpoints, release version_hash). What it could not express is whether a
-- given service is meant to be *discoverable* by someone other than the wallet that onboarded it.
-- Without that distinction a marketplace listing would publish every customer's paid endpoint the
-- moment they tested it, so listing is opt-in and off by default.
ALTER TABLE services
  ADD COLUMN marketplace_listed boolean NOT NULL DEFAULT false,
  ADD COLUMN description text,
  ADD COLUMN logo_url text,
  ADD COLUMN marketplace_rank integer NOT NULL DEFAULT 100,
  -- The quote request carries a target agent identity that gets hashed into the on-chain
  -- attestation (apps/orchestrator-worker/src/attestation-builder.ts). A marketplace entry has to
  -- produce a complete quote request on its own, and deriving this from external_service_id would
  -- silently change the attested identity of services already onboarded under a different one.
  ADD COLUMN target_agent_id text,
  -- Which policy a listing is offered under. The schema has no services -> policies relation
  -- (policy_hash travels on the quote request), so without this a listing would have to *guess* a
  -- policy -- and guessing "the standard one" is wrong for any service registered under a
  -- different policy, quietly attributing its runs to a policy it was never tested against.
  ADD COLUMN marketplace_policy_hash bytea
    CHECK (marketplace_policy_hash IS NULL OR octet_length(marketplace_policy_hash) = 32);

-- Only listed rows are ever scanned; an unlisted catalog can grow without slowing this down.
CREATE INDEX services_marketplace_listed_idx
  ON services (marketplace_rank, created_at)
  WHERE marketplace_listed AND active;

-- The self-test target predates onboarding: it was seeded straight into the catalog, so it has no
-- onboarding call to carry this metadata. Update-if-present rather than insert -- a fresh database
-- has no such row, and this migration cannot invent the organization, release, and real OpenAPI
-- version_hash that row depends on.
UPDATE services
SET marketplace_listed = true,
    marketplace_rank = 0,
    name = 'GOAT Testnet Paid API',
    description =
      'Shipyard''s own x402 reference service on GOAT Testnet3. It charges a real on-chain '
      || 'payment per call and ships in two modes: one with the receipt-replay bug, one with it '
      || 'fixed. Use it to see a full run end to end before pointing Shipyard at your own API.',
    logo_url = '/logo-mark.png',
    target_agent_id = 'agent:shipyard402-selftest',
    -- The policy every previous run of this target was quoted under. Deliberately looked up by
    -- name rather than written as a literal hash: the hash is derived from that row's content, so
    -- restating it here would be a second source of truth that can silently drift from the first.
    marketplace_policy_hash = (
      SELECT policy_hash FROM policies WHERE name = 'testnet3-real-merchant-selftest' AND version = 'v1'
    )
WHERE external_service_id = 'service:x402-demo-target:testnet3-real-merchant';

COMMIT;
