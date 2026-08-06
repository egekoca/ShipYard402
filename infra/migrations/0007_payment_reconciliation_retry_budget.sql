BEGIN;

-- A customer completing a wallet payment (open extension, review, confirm) routinely takes
-- longer than the previous 8-attempt / ~60s-capped-backoff window (~5 minutes total): jobs were
-- dead-lettering as "payment not received" while the customer was still mid-flow. Widen the
-- default budget to give a real human payer a realistic amount of time; apps/payment-worker's
-- retry backoff cap was raised alongside this to spread the extra attempts out (~1 hour total).
ALTER TABLE payment_reconciliation_jobs
  ALTER COLUMN maximum_attempts SET DEFAULT 24;

COMMIT;
