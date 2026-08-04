# GOAT Testnet3 orchestrator mechanism verification — 2026-08-05

## Scope

This record proves that every mechanism in the `FUNDED → DELIVERED_PASS` orchestrator pipeline (`apps/orchestrator-worker`) works against real infrastructure: a real OpenAI risk-classification call, a real GOAT Testnet3 native-asset procurement payment independently verified on-chain, a real execution of the payment-proof replay check against a live `apps/x402-demo-target` process, a real EIP-712-signed tool receipt, and a real EIP-712-signed attestation submitted to and read back from the deployed `ShipyardRunRegistry` contract.

It does **not** prove a real GOAT Flow customer payment, a fully automated single-command orchestrator run, mainnet activity, revenue, or third-party traction. See "What was simulated" and "Known limitation" below.

## Network and signers

| Field | Value |
| --- | --- |
| Environment | GOAT Testnet3 |
| Chain ID | `48816` (`0xbeb0`) |
| Registry contract | [`0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd`](https://explorer.testnet3.goat.network/address/0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd) |
| Orchestrator / attestor signer | `0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10` (same disposable signer as the [prior registry deployment](./testnet3-smoke-2026-08-04.md)) |
| Demo-target receiving signer | `0xE390d13a63F2156eF025834f2C9e7f986AD3d390` (new, disposable, testnet-only, receives procurement payments only — never signs) |
| Tool-receipt signer | `0x314aAA78f092F11288D82BebecEA38d0AAcDC607` (new, disposable, testnet-only, represents the demo tool provider's EIP-712 signing identity) |

All three keys are marked `goat-testnet3-only` in their local wallet files (mode `0600`, gitignored) and must never be funded or reused on mainnet.

## What is real

1. **Attestor authorization.** The registry owner authorized the orchestrator signer as an attestor: [`0x2ce2de4f027aa3eeb3b0b3e8ee3066b9806574efa520f01533ddd2eb5f2d1b27`](https://explorer.testnet3.goat.network/tx/0x2ce2de4f027aa3eeb3b0b3e8ee3066b9806574efa520f01533ddd2eb5f2d1b27).
2. **AI risk classification.** A real OpenAI Responses API call (model `gpt-5.1`, strict JSON-schema structured output) against a description of the target service returned a genuine risk assessment (`MEDIUM`) and six proposed scenario names, none of which was literally `payment-proof-replay` — demonstrating why the AI's output is advisory only (ADR-0006).
3. **Deterministic plan compilation.** `compileTestPlan()` (`@shipyard402/risk-classifier`) forced the mandatory `payment-proof-replay` scenario into the plan regardless of the AI's omission, and correctly clamped a synthetic over-budget AI proposal (`999999`) down to the configured ceiling (`200`).
4. **Real procurement payment.** A native BTC transfer of `1000` wei from the orchestrator signer to the demo-target receiving signer: [`0xc6c15b7b5eef5ef8e00e1b69a4fbea5fcd0ad02d6d9402109eba428a456bf2f0`](https://explorer.testnet3.goat.network/tx/0xc6c15b7b5eef5ef8e00e1b69a4fbea5fcd0ad02d6d9402109eba428a456bf2f0).
5. **Real on-chain payment verification.** `x402-demo-target`'s `/purchase` route (real running process) independently verified that transaction via a read-only Testnet3 RPC call — status, recipient, amount, confirmations — before issuing its receipt.
6. **Real replay-check execution.** `ProtectedDeliveryReplayRunner` (unmodified, already-tested package) executed the `payment-proof-replay` scenario over real HTTP against the live `x402-demo-target` process using the earned receipt: initial delivery `200`, replay attempt `409` → `result: PASS`.
7. **Real signed tool receipt.** An EIP-712 `ToolReceipt` was signed by the tool-receipt signer and independently re-verified with `@shipyard402/evidence-sdk`'s `verifyToolReceipt()` — signature valid, signer recovered correctly.
8. **Real evidence pack.** Stored in PostgreSQL and served publicly at `GET /v1/runs/run_e2e-verify-1/evidence` (the new api-gateway route), matching the on-chain roots exactly.
9. **Real attestation.** An EIP-712-signed `RunAttestation` was submitted to the registry: [`0x4b87340afd68b954490246c66476344ab0bdccb819d3a96eb107cc9610af961d`](https://explorer.testnet3.goat.network/tx/0x4b87340afd68b954490246c66476344ab0bdccb819d3a96eb107cc9610af961d). Read back independently via `getRun`/`isRunRecorded`: `isRecorded: true`, `result: PASS (0)`, all fields matching.

While wiring step 9, this run caught and fixed a real bug: `EthersRegistryAttestor` passed the attestation's `result` field to the contract call as the string `"PASS"` instead of its Solidity enum index — the EIP-712 signature encoding was already correct, only the live contract call argument was wrong. Confirmed fixed by this same successful transaction.

## What was simulated

The **customer payment leg** (the run reaching `FUNDED` in the first place) used a directly-seeded PostgreSQL row with a synthetic proof hash, not a real GOAT Flow settlement — real customer payments remain blocked on GOAT Flow Testnet3 merchant onboarding, tracked separately and unrelated to this pipeline. This is the only simulated part of this record; everything from `FUNDED` onward used real infrastructure as described above.

## Known limitation

The fully automated, single-command `orchestrator-worker` process could not be run end-to-end in this session's sandbox: `packages/policy-engine`'s mandate construction correctly refuses to list a loopback host (`127.0.0.1`) in `allowedHosts` (SSRF protection, `isForbiddenHost`), and this sandbox has no way to give the locally-running `x402-demo-target` process a real externally-resolvable hostname. This is a sandbox network-topology limitation, not a code defect — the guard is working as intended. Every real mechanism it would have exercised was instead verified directly against live Testnet3 infrastructure, as documented above. Running the real `orchestrator-worker` process against a `x402-demo-target` deployed to a reachable host is the natural next step.

## Reproduction safeguards

Reused the same safeguards as the [prior registry deployment](./testnet3-smoke-2026-08-04.md): exact chain ID/RPC checks, disposable testnet-only signer files, and — for `authorize-attestor.mjs` — reuse of an existing authorization record instead of re-submitting a redundant transaction.
