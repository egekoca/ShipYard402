BEGIN;

-- Consolidate any duplicate organizations for the same wallet that were created before this
-- constraint existed (the onboarding get-or-create used to be a non-atomic check-then-insert) onto
-- the earliest one, so the new UNIQUE constraint below doesn't fail against pre-existing data.
CREATE TEMPORARY TABLE organization_dedup_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, billing_wallet,
         row_number() OVER (PARTITION BY billing_wallet ORDER BY created_at, id) AS rn
  FROM organizations
),
canonical AS (
  SELECT billing_wallet, id AS canonical_id FROM ranked WHERE rn = 1
)
SELECT r.id AS duplicate_id, c.canonical_id
FROM ranked r
JOIN canonical c ON c.billing_wallet = r.billing_wallet
WHERE r.rn > 1;

UPDATE services
SET organization_id = organization_dedup_map.canonical_id
FROM organization_dedup_map
WHERE services.organization_id = organization_dedup_map.duplicate_id;

UPDATE quotes
SET organization_id = organization_dedup_map.canonical_id
FROM organization_dedup_map
WHERE quotes.organization_id = organization_dedup_map.duplicate_id;

DELETE FROM organizations WHERE id IN (SELECT duplicate_id FROM organization_dedup_map);

ALTER TABLE organizations
  ADD CONSTRAINT organizations_billing_wallet_key UNIQUE (billing_wallet);

COMMIT;
