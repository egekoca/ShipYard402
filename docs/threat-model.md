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
| Malicious provider | EIP-712 ToolReceipt, expected signer, on-chain payment linkage, deterministic local cross-check | Provider result rejected |
| Webhook replay | Raw-body signature verification, timestamp/nonce, durable idempotency | Duplicate ignored |
| RPC outage/disagreement | Pinned chain ID, dedicated + secondary RPC, finality policy | INCONCLUSIVE, never PASS |
| Target changes during run | Version/manifest snapshots and start/end drift checks | INCONCLUSIVE or new run |
| Evidence tampering | Canonical hashes, signed receipts, reproducible root, immutable registry | Verification fails |
| Secret leakage | KMS/Vault references, isolated signer, log redaction | Rotate/revoke and pause writes |
| Attestor compromise | Owner-controlled rotation, events, pause, expiry, public discrepancy process | Pause new attestations |
| False confidence | Version/policy/expiry scope and explicit non-audit language | No general safety claim |

## Known incomplete controls

- DNS resolution and redirect-chain enforcement are designed but not yet wired to an HTTP egress broker.
- GOAT Flow webhook signing is deployment-specific and is not implemented until the active Mainnet contract is verified.
- Signer service/KMS integration and the production worker bootstrap are not implemented; production boot is disabled.
- External provider independence and receipt signer registration are not yet established.
