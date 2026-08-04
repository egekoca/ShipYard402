# ADR-0018: Use PostgreSQL leases for customer-payment reconciliation jobs

Status: accepted, 2026-08-04.

## Context

Moving a run from `PAYMENT_REQUIRED` to `FUNDED` requires authenticated merchant status, an immutable provider proof, and a matching GOAT mainnet transaction receipt. An in-memory timer can lose work during restart, while publishing a queue message outside the run-state transaction can create an unobservable gap. Redis is not otherwise required by the current vertical slice.

## Decision

The `PAYMENT_REQUIRED` domain event creates one `payment_reconciliation_jobs` row in the same PostgreSQL transaction as the run revision and outbox event. Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, a bounded lease, bounded attempts, exponential retry, and explicit `COMPLETED` or `DEAD_LETTER` terminal states. A crashed worker's stale lease can be reclaimed without incrementing the economic attempt counter.

The payment worker has authenticated GOAT x402 read access and read-only GOAT RPC access. It receives no payer signer, attestor signer, private key, arbitrary HTTP origin, or transaction-broadcasting client.

## Consequences

Payment reconciliation survives process restarts without adding Redis to the MVP path. PostgreSQL availability is required for both API and worker progress. Long-running work must remain shorter than the lease or add lease renewal before its maximum execution time grows beyond the current bound.
