# Threat Model

## Protected assets

- Customer funds and payment proofs
- Payer, deployer and attestor authority
- Merchant API/webhook credentials
- Mandates, allowlists and budget ledgers
- Raw target requests/responses
- Tool receipts, evidence packs and results
- Revenue and traction integrity

## Principal threats and controls

| Threat | Primary controls | Failure behavior |
|---|---|---|
| Prompt injection | Untrusted-content separation, typed plan, no LLM signer/network/DB authority | Reject plan or INCONCLUSIVE |
| SSRF/DNS rebinding | Bare-host allowlist, private/link-local block, runtime DNS/IP recheck, redirect validation | Request denied |
| Budget drain | Immutable mandate, total/single/tool/retry ceilings, approval threshold | Purchase denied and audited |
| Self-dealing | Agent ID and controlled-host block, first-party disclosure | Purchase denied or excluded from traction |
| Duplicate charge | Stable dappOrderId/idempotency key, status reconciliation before retry | No second transfer |
| Payment proof replay | Unique database proof hash and on-chain `paymentProofRun` mapping | Second run rejected |
| Forged GOAT proof | Independent chain/tx/log/token/payer/recipient/amount verification | Run not funded |
| Frontend secret exposure | Separately deployed public package graph; server SDK, DB and signers are backend-only | Build/release blocked |
| Cross-chain RPC confusion | RPC `eth_chainId` must equal 2345 before receipt use | Receipt rejected |
| Malicious provider | EIP-712 ToolReceipt, expected signer, on-chain payment linkage, deterministic local cross-check; opt-in independent provider response signing verified against a registered signer address (`packages/protected-delivery-runner/src/provider-signature.ts`) | Provider result rejected; a PASS whose response can't be verified against the registered signer downgrades to INCONCLUSIVE |
| Webhook replay | Raw-body signature verification, timestamp/nonce, durable idempotency | Duplicate ignored |
| RPC outage/disagreement | Pinned chain ID, dedicated + secondary RPC, finality policy | INCONCLUSIVE, never PASS |
| Target changes during run | Version/manifest snapshots and start/end drift checks | INCONCLUSIVE or new run |
| Evidence tampering | Canonical hashes, signed receipts, reproducible root, immutable registry | Verification fails |
| Secret leakage | KMS/Vault references, isolated signer, log redaction | Rotate/revoke and pause writes |
| Attestor compromise | Owner-controlled rotation, events, pause, expiry, public discrepancy process | Pause new attestations |
| False confidence | Version/policy/expiry scope and explicit non-audit language | No general safety claim |

## Known incomplete controls

- GOAT Flow webhook signing is deployment-specific and is not implemented until the active Mainnet contract is verified.
- Orchestrator signer keys can now be loaded from a real encrypted (V3) keystore instead of a plaintext env var, and `APP_ENV=production` refuses to boot with a raw key at all (`apps/orchestrator-worker/src/signer-key-source.ts`). This is a real step up, not a full remote KMS/HSM -- the decrypted key still lives in the worker process's memory for its lifetime, and secret rotation is still manual.
- Provider response signing and its expected-signer registration (`DEMO_TARGET_PROVIDER_SIGNER_ADDRESS`) are implemented and opt-in, disabled by default. `apps/x402-demo-target` is a first-party demo service, so this doesn't yet demonstrate independence from a genuinely separate operator -- the value today is limited to detecting a compromised or buggy orchestrator fetch client fabricating a result, not a dishonest third-party provider.
