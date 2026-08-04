# ADR-0009: Optimistic state machine and transactional outbox

Status: Accepted

Every transition requires an authorized actor, expected revision, event time, and idempotency key. Database uniqueness protects `(run_id, revision)`, `(run_id, idempotency_key)`, request keys, order IDs, transaction/log identities, and payment proof hashes. Queue publication uses a transactional outbox. A funded run cannot disappear through cancellation or expiry; it must deliver scoped evidence, including INCONCLUSIVE when necessary.
