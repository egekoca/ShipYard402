# Shipyard402

Autonomous Release Assurance & Runtime Sentinel for x402 services on GOAT Network.

Shipyard402 sells version-scoped, policy-scoped, expiry-bound execution evidence. A `PASS` result is not a security audit or a general safety certificate.

## Current implementation status

The repository now has independently deployable frontend and backend boundaries:

- `apps/web-dashboard`: Next.js public UI. It can import only the public API client and has no merchant, database, signer, or chain-write dependencies.
- `apps/api-gateway`: Fastify backend for capability-bound quotes, idempotent runs, and adapter-backed HTTP 402 challenges.
- `apps/payment-worker`: separate backend worker boundary for bounded payment polling, deterministic rejection, retry, and dead-letter behavior.
- backend packages: GOAT Flow merchant adapter, deterministic settlement reconciliation, read-only GOAT receipt reader, PostgreSQL receipt/order stores, policy engine, evidence SDK, and run domain.
- `contracts`: append-only `ShipyardRunRegistry` and Foundry test suite.

The API gateway now uses PostgreSQL for catalog-bound quotes, idempotent run state, payment-order context, domain events, and transactional outbox records. Development defaults to the local Compose database. Production startup fails closed unless an explicit PostgreSQL URL and a complete reviewed GOAT x402 merchant configuration are present. Unit/integration mocks never represent mainnet evidence, and signer/attestor processes remain deliberately separate.

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
cd contracts && forge test
```

The local PostgreSQL service uses a digest-pinned official `postgres:17.10-alpine3.23` image, binds only to `127.0.0.1:5432`, and applies `infra/migrations/*.sql` only when its named development volume is first created. The credentials in `compose.yaml` are local-development defaults and must never be used in a deployed environment. `corepack pnpm infra:down` stops the service without deleting its data volume.

`corepack pnpm dev` starts only the browser-facing dashboard and API gateway. The payment worker is intentionally excluded from the default development command because it must never make economic actions without durable PostgreSQL/queue wiring and reviewed GOAT credentials. Its explicit command is `corepack pnpm dev:payment-worker`; it currently fails closed until that wiring is configured.

Without GOAT merchant credentials the local API starts in a visible `degraded` state: PostgreSQL is available, but quote creation and payment challenge procurement fail closed with `503`. No token, recipient, or merchant capability is fabricated for local development. `GET http://127.0.0.1:3001/health` reports these boundaries explicitly.

Never put private keys, GOAT Flow API secrets, webhook secrets, authorization payloads, or payment proofs in the repository, logs, prompts, or public evidence.
