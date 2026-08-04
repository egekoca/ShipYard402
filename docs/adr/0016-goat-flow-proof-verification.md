# ADR-0016: Treat GOAT Flow proof signature as an unsigned digest

Status: accepted, 2026-08-04.

## Context

`goatflow-sdk-server` 0.3.0 documents `OrderProofResponse.signature` as a bare Keccak-256 checksum over a subset of payload fields, not a cryptographic attestation. Trusting it would let a provider response become the financial source of truth.

## Decision

The adapter exposes this value only as `providerDigest`. `PaymentReconciler` independently reads the GOAT chain-2345 transaction receipt and requires exact transaction hash, successful status, ERC-20 token, payer, recipient, amount, and log-index matches. A unique proof hash is committed atomically with the `FUNDED` transition, receipt row, run event, and outbox event.

## Consequences

Provider confirmation without matching on-chain evidence cannot fund a run. RPC failure or ambiguity blocks progress rather than producing a false funded state.
