# Shipyard402 Architecture Baseline

Status: implementation baseline, 2026-08-04.

## System context

Shipyard402 receives release assurance requests from customer agents, CI systems, and service owners. It sells a GOAT Flow `ERC20_DIRECT`-funded run, procures allowlisted paid tools, executes deterministic payment-delivery tests, and publishes scoped evidence. GOAT Flow, target services, tool providers, evidence storage, GOAT RPCs, and the public explorer are external systems.

## Containers

The containers below (`apps/*`) are what is actually implemented and deployable today. A separate Sentinel Worker (risk-adjusted canary scheduling/drift detection) and a standalone Signer Service were part of the original target design but were never split out: signing lives in-process in Orchestrator Worker and Payment Worker via a `SignerKeySource` (raw key in development, encrypted keystore in production), and durable job queuing is PostgreSQL-backed leased jobs rather than a separate broker (there is no Redis/BullMQ in this system).

| Container | Responsibility | Trust level |
|---|---|---|
| API Gateway (`apps/api-gateway`) | Auth, quote, x402 merchant boundary, public run reads | Internet-facing |
| Orchestrator Worker (`apps/orchestrator-worker`) | Manifest/OpenAPI analysis, risk plan, procurement authorization, protected-delivery execution, evidence assembly, on-chain attestation | No public ingress; holds procurement + attestation signer key sources |
| Payment Worker (`apps/payment-worker`) | Payment reconciliation against on-chain and settlement state | No public ingress; no signer key |
| PostgreSQL | State, receipts, evidence metadata, accounting, and durable leased job queues | Private data boundary |
| Web Dashboard (`apps/web-dashboard`) | Release-run UI, redacted evidence and economic metadata; public API client only | Public, no secrets |
| x402 Demo Target (`apps/x402-demo-target`) | Reference x402-protected tool endpoint (vulnerable/protected modes) used to exercise the pipeline in scenarios | Non-production, demo/test only |
| ShipyardRunRegistry | Immutable version/policy/expiry attestation | GOAT mainnet |

## Component boundaries

- `quote-engine` does not create payment orders. It prices a run from a verified runtime capability snapshot.
- `x402-payments` defines merchant/payer ports and verifies settlement independently from provider digest fields.
- `policy-engine` is the only component authorized to approve a purchase intent.
- `run-domain` owns legal state transitions and optimistic concurrency rules.
- `evidence-sdk` owns the signed ToolReceipt schema, signature checks, and receipt root.
- `protected-delivery-runner` owns deterministic initial-delivery and payment-proof replay classification. It receives network access through a restricted client port, accepts only origin-relative routes, never returns the raw payment receipt or response body, and produces hash-only `PASS`, `FAIL`, or `INCONCLUSIVE` evidence.
- LLM output is untrusted input to a deterministic plan compiler; it cannot call a signer or mutate persistence.
- A provider response is never a financial truth source. On-chain receipt verification and deterministic invariants remain mandatory.
- `apps/web-dashboard` is independently deployable and cannot import backend domain, GOAT Flow server SDK, PostgreSQL, worker, or signer packages.
- `apps/api-gateway` owns internet ingress and merchant order creation. Payment polling and settlement reconciliation execute outside the request path in a backend worker.
- The GOAT Flow server SDK exists only behind `X402MerchantAdapter`; its API key and secret never appear in public DTOs or frontend bundles.
- GOAT Flow's order-proof `signature` is treated as an unsigned provider digest. Funding requires an environment-scoped GOAT receipt and an exact ERC-20 Transfer log match; production permits chain 2345, while explicit development Testnet3 permits chain 48816.

## Frontend/backend dependency direction

```text
apps/web-dashboard
  -> packages/public-api-client
  -> HTTPS only
  -> apps/api-gateway
       -> quote-engine / run-domain
       -> X402MerchantAdapter -> goatflow-sdk-server

payment worker
  -> PaymentReconciler
       -> X402MerchantAdapter
       -> ViemGoatReceiptReader (read-only RPC)
       -> PostgresPaymentReconciliationStore (atomic receipt + run event + outbox)

orchestrator worker
  -> ProtectedDeliveryReplayRunner
       -> restricted target client (allowlisted origin only)
       -> hash-only replay evidence (no raw receipt or protected payload)
```

The payment worker uses leased PostgreSQL reconciliation jobs with bounded retries and deterministic dead-letter rules. Its executable bootstrap fails closed until PostgreSQL and a complete environment-matched merchant capability are configured; it is a separate backend deployment, not a Next.js background task.

Dependencies point inward toward ports and deterministic domain packages. Frontend packages have no path to economic credentials or persistence.

## Deployment topology

The MVP is a modular monolith split into an internet-facing API and separate backend worker processes; workers hold their own signer key sources rather than delegating to a standalone signer service. API and workers use separate service identities. PostgreSQL is private. Public ingress reaches only the API and the web dashboard. Egress from workers is restricted to the target, allowlisted providers, GOAT Flow, approved RPCs, and evidence storage.

Production API/orchestrator-worker/payment-worker boot requires durable PostgreSQL and reviewed mainnet merchant capability records. Payer/attestor KMS integration and real merchant credentials remain launch blockers. The merchant adapter, order-context store, payment reconciler, read-only chain receipt implementation, and replay runner are present but have not been exercised with a real paid customer flow.
