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

Production boot remains disabled until real merchant credentials, reviewed runtime capabilities, the complete PostgreSQL API repositories, and isolated signer references are configured. Unit/integration mocks never represent mainnet evidence.

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
- Foundry for Solidity tests

```bash
corepack pnpm install
corepack pnpm verify
cd contracts && forge test
```

`corepack pnpm dev` starts only the browser-facing dashboard and API gateway. The payment worker is intentionally excluded from the default development command because it must never make economic actions without durable PostgreSQL/queue wiring and reviewed GOAT credentials. Its explicit command is `corepack pnpm dev:payment-worker`; it currently fails closed until that wiring is configured.

Never put private keys, GOAT Flow API secrets, webhook secrets, authorization payloads, or payment proofs in the repository, logs, prompts, or public evidence.
