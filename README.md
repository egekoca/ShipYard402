# Shipyard402

Autonomous Release Assurance & Runtime Sentinel for x402 services on GOAT Network.

Shipyard402 sells version-scoped, policy-scoped, expiry-bound execution evidence. A `PASS` result is not a security audit or a general safety certificate.

## Current implementation status

The repository now has independently deployable frontend and backend boundaries:

- `apps/web-dashboard`: Next.js public UI. It can import only the public API client and has no merchant, database, signer, or chain-write dependencies.
- `apps/api-gateway`: Fastify backend for capability-bound quotes, idempotent runs, and adapter-backed HTTP 402 challenges.
- `apps/payment-worker`: separate read-only backend worker for durable leased payment polling, deterministic settlement rejection, bounded retry, and dead-letter behavior.
- backend packages: GOAT Flow merchant adapter, deterministic settlement reconciliation, read-only GOAT receipt reader, protected-delivery replay runner, PostgreSQL receipt/order stores, policy engine, evidence SDK, and run domain.
- `contracts`: append-only `ShipyardRunRegistry` and Foundry test suite.
- `apps/x402-demo-target`: a controlled demo paid resource with two selectable modes — `V1_VULNERABLE` accepts a payment receipt more than once, `V2_PROTECTED` rejects a replayed receipt with `409`. Its `/purchase` route requires a real confirmed native-asset payment (verified on-chain, read-only) before issuing that receipt, so procurement against it is a real GOAT Testnet3 transaction, not a fabricated one. Real GOAT Flow-funded *customer* runs are still blocked on Testnet3 merchant onboarding.
- `apps/orchestrator-worker`: leased-job worker that drives a `FUNDED` run through `ANALYZING → PLAN_COMPILED → PROCURING → EXECUTING → EVIDENCE_BUILDING → ATTESTING → DELIVERED_*` (see `docs/state-machine.md`). Calls a real OpenAI structured-outputs risk classifier whose proposal is advisory only — `@shipyard402/risk-classifier`'s deterministic compiler always keeps the mandatory scenario and clamps the proposed budget (ADR-0006). Pays `x402-demo-target` with a real signed GOAT Testnet3 transaction, runs the existing replay-check scenario against the earned receipt, signs an EIP-712 `ToolReceipt`, and submits a real EIP-712-signed attestation to the deployed `ShipyardRunRegistry`. Not crash-resumable mid-sequence yet (dead-letters instead of blindly retrying past `FUNDED`).

The API gateway now uses PostgreSQL for catalog-bound quotes, idempotent run state, payment-order context, domain events, and transactional outbox records. Development defaults to the local Compose database. Production startup fails closed unless an explicit PostgreSQL URL and a complete reviewed GOAT x402 merchant configuration are present. Unit/integration mocks never represent mainnet evidence, and signer/attestor processes remain deliberately separate.

A first GOAT Testnet3 smoke run is public: the isolated test signer received native faucet gas and deployed the append-only registry. The [evidence record](./docs/evidence/testnet3-smoke-2026-08-04.md) includes explorer transactions, bytecode hash, cost, and current limitations. It is deliberately not labeled as x402 payment evidence, customer traction, revenue, or mainnet proof.

A second Testnet3 record verifies the orchestrator mechanism itself: a real OpenAI risk-classification call, a real on-chain procurement payment independently verified by `x402-demo-target`, a real execution of the payment-proof replay check, a real EIP-712-signed tool receipt, and a real EIP-712-signed attestation submitted to and read back from the registry. See the [evidence record](./docs/evidence/testnet3-orchestrator-run-2026-08-05.md) for exact transaction hashes, what was simulated (only the customer-payment leg, still blocked on GOAT Flow merchant onboarding), and a disclosed sandbox limitation that prevented running the fully automated single-command worker end-to-end.

## Application boundaries

```text
Browser -> web-dashboard -> public-api-client -> api-gateway
                                              -> GOAT Flow merchant adapter
Payment worker -> payment reconciler -> GOAT RPC (read only)
                                  \-> PostgreSQL transaction/outbox
Signer/attestor processes are separate and are not reachable from the browser or LLM.
```

## Local verification

Requirements:

- Node.js 24+
- Corepack
- Docker-compatible runtime and Docker Compose (Docker Desktop or Colima)
- Foundry for Solidity tests

```bash
corepack pnpm install
corepack pnpm infra:up
corepack pnpm test:postgres
corepack pnpm verify
```

`pnpm verify` includes the Foundry unit, 512-run fuzz, and stateful invariant suites. Install the stable Foundry toolchain from its official installer before running the command.

The local PostgreSQL service uses a digest-pinned official `postgres:17.10-alpine3.23` image and binds only to `127.0.0.1:5432`. `infra:up` waits for database health, then runs checksum-verified migrations under a PostgreSQL advisory lock. The credentials in `compose.yaml` are local-development defaults and must never be used in a deployed environment. `corepack pnpm infra:down` stops the service without deleting its data volume.

`corepack pnpm dev` starts only the browser-facing dashboard and API gateway. The payment worker is intentionally excluded from the default development command and has no signer or transaction-broadcast capability. `corepack pnpm dev:payment-worker` starts it only when PostgreSQL plus complete reviewed GOAT merchant credentials are configured; it verifies the authenticated merchant capability before claiming a job.

Without GOAT merchant credentials the local API starts in a visible `degraded` state: PostgreSQL is available, but quote creation and payment challenge procurement fail closed with `503`. No token, recipient, or merchant capability is fabricated for local development. `GET http://127.0.0.1:3001/health` reports these boundaries explicitly.

Never put private keys, GOAT Flow API secrets, webhook secrets, authorization payloads, or payment proofs in the repository, logs, prompts, or public evidence.

## GOAT Testnet3 smoke commands

These commands use an isolated disposable signer under the ignored `.local/testnet` directory. The signer file is testnet-only and must not be copied into a deployed environment.

```bash
corepack pnpm testnet:wallet:create
corepack pnpm testnet:status
corepack pnpm testnet:deploy:registry
```

The official faucet requires an interactive anti-bot challenge at `https://bridge.testnet3.goat.network/faucet`; scripts do not bypass it. Faucet BTC is native gas, not proof that an ERC-20 x402 payment asset is available.
