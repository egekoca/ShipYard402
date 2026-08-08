<div align="center">

<img src="apps/web-dashboard/public/logo-mark.png" alt="Shipyard402" width="88" />

# Shipyard402

**Release assurance for paid APIs — pay for real, attack for real, prove it on-chain.**

[![CI](https://github.com/egekoca/ShipYard402/actions/workflows/ci.yml/badge.svg)](https://github.com/egekoca/ShipYard402/actions/workflows/ci.yml)
[![Live Demo](https://img.shields.io/badge/demo-shipyard402.vercel.app-black?logo=vercel&logoColor=white)](https://shipyard402.vercel.app)
[![Status](https://img.shields.io/badge/status-testnet%20MVP-yellow)](./docs/business-model.md)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)

[**Live Demo**](https://shipyard402.vercel.app) · [How it works](#how-a-run-works) · [Architecture](#architecture) · [Evidence](./docs/evidence/) · [Business model](./docs/business-model.md)

</div>

---

## The problem

APIs that charge per request (using the [x402](https://www.x402.org/) payment standard) have a payment layer, not just business logic. That payment layer can break quietly: a receipt gets accepted twice, a payment check gets skipped entirely, a forged receipt gets treated as real. Usually nobody notices until a paying customer does — and by then it's an incident, not a bug report.

## What Shipyard402 does

Before you release a new version of a paid API, Shipyard402:

1. **Pays your API for real** — a real on-chain transaction, not a mock.
2. **Tries to break the payment logic** with three attacks: reusing the same receipt twice, requesting paid content with no payment at all, and submitting a forged receipt.
3. **Records the result on-chain** — a signed PASS or FAIL attestation that anyone can verify independently, without taking Shipyard402's word for it.

If any attack succeeds, the run fails — and you find out before your customers do.

## What a PASS actually means

A PASS is **not** a general security certificate. It means: this exact version of your service, tested against this exact set of attacks, at this exact time, held. It doesn't carry over to your next release — every release gets its own run, because every release can reintroduce the bug.

See [`docs/business-model.md`](./docs/business-model.md) for the full breakdown of what's tested, what isn't, and who pays for it.

## How a run works

1. A customer connects a wallet and pays for the run — no copy-pasted addresses, the payment happens from their own browser wallet.
2. An AI proposes which attack scenarios matter most for this specific service. A fixed, non-AI compiler decides what actually runs — the AI can suggest, but it never controls money or test coverage.
3. Shipyard402 pays the target API for real, to earn a genuine receipt to test with.
4. It runs the attacks against the live service and collects evidence of what happened.
5. The final result is signed and written on-chain, to a public registry contract, alongside the evidence.

## Architecture

```text
Browser --> web-dashboard --> api-gateway --> GOAT Flow (merchant payments)
                                          --> PostgreSQL

payment-worker      --> confirms customer payments on-chain
orchestrator-worker --> runs the test pipeline: risk analysis, procurement,
                        attacks, evidence, on-chain attestation
```

| Component | What it does |
|---|---|
| `apps/web-dashboard` | Public frontend. Holds no credentials or signing keys — payments are signed in the customer's own wallet. |
| `apps/api-gateway` | Backend API: quotes, run creation, payment challenges. |
| `apps/payment-worker` | Confirms a customer's on-chain payment before a run is allowed to start. |
| `apps/orchestrator-worker` | Runs the actual test: risk analysis, paid procurement, attacks, evidence, on-chain attestation. |
| `apps/x402-demo-target` | A demo paid API used to show the flow — one mode with the payment bug, one mode with it fixed. |
| `contracts/` | The on-chain registry contract that stores attestations. |
| `packages/` | Shared backend logic: payment verification, chain reading, policy engine, evidence handling. |

Signer and attestor processes are isolated from the browser and from the AI — neither can move funds or write to the registry directly.

## Tech stack

<div align="left">

![Next.js](https://img.shields.io/badge/Next.js-000000?logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-363636?logo=solidity&logoColor=white)
![Foundry](https://img.shields.io/badge/Foundry-000000?logo=ethereum&logoColor=white)
![IPFS](https://img.shields.io/badge/IPFS-65C2CB?logo=ipfs&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?logo=vercel&logoColor=white)
![GOAT Network](https://img.shields.io/badge/GOAT_Network-testnet3-orange)

</div>

## Current status

| | |
|---|---|
| Core pipeline (quote → pay → test → attest) | Working, proven end-to-end on GOAT Testnet3 |
| Fee calculation | Real and implemented — testnet placeholder pricing, not final |
| Real customer payments | Not yet live — waiting on GOAT Flow merchant onboarding |
| Always-on production workers | Not yet — currently run manually, not on managed infrastructure |

Real testnet runs, with transaction hashes and honest write-ups of what broke along the way, are in [`docs/evidence/`](./docs/evidence/).

## Getting started

Requirements:

- Node.js 24+
- Corepack
- Docker-compatible runtime and Docker Compose (Docker Desktop or Colima)
- Foundry, for the Solidity test suite

```bash
corepack pnpm install
corepack pnpm infra:up      # starts local PostgreSQL + IPFS
corepack pnpm test:postgres
corepack pnpm verify        # runs the full test suite, including contracts
```

`corepack pnpm dev` starts the dashboard and API gateway. The background workers aren't part of the default dev command — start them separately once PostgreSQL and merchant credentials are configured:

```bash
corepack pnpm dev:payment-worker
```

Without merchant credentials configured, the API starts in a visible `degraded` state rather than faking a working payment flow — check `GET /health` to see exactly what's missing.

> Never commit private keys, API secrets, or payment proofs to this repository.

## Learn more

| Doc | What's in it |
|---|---|
| [`docs/business-model.md`](./docs/business-model.md) | Who pays, for what, and current revenue status |
| [`docs/architecture.md`](./docs/architecture.md) | System design and trust boundaries |
| [`docs/state-machine.md`](./docs/state-machine.md) | The exact states a run moves through |
| [`docs/evidence/`](./docs/evidence/) | Real GOAT Testnet3 runs, with transaction hashes |

---

<div align="center">

Built for the GOAT Network x402 track.

</div>
