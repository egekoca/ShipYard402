# GOAT Testnet3 first fully real end-to-end run — 2026-08-06

## Scope

This record proves the complete `ANALYZING → DELIVERED_PASS` pipeline end-to-end with **no simulated legs**: a real GOAT Flow customer payment (not a seeded database row), independently verified on-chain, automatically triggering the orchestrator pipeline already proven mechanically in [testnet3-orchestrator-run-2026-08-05.md](./testnet3-orchestrator-run-2026-08-05.md) — real AI risk classification, a real procurement payment, real scenario execution, real signed evidence, and a real on-chain attestation.

It does not prove third-party traction: the customer wallet and the merchant receiving address are the same address (see "Self-dealing disclosure" in the orchestrator plan) — this is a first-party self-test proving the mechanism, not external revenue.

## Run

| Field | Value |
| --- | --- |
| Run ID | `run_19afc615-5d80-4b0f-895a-34a91dcf78bb` |
| Final status | `DELIVERED_PASS` |
| Requester / merchant receiving wallet | `0x63e7DFb5e96f3e3911110511A89Ea072Cd2c0030` |
| Quote total | 4.700000 USDC |
| Scenarios executed | `payment-proof-replay`, `unpaid-access-denial`, `tampered-receipt-rejection` — all `PASS` |

## What is real

1. **Real GOAT Flow order and customer payment.** GOAT Flow order `b4cff151-e188-4672-810a-ff53c2a60103` was created against the merchant's live fee balance (topped up on GOAT Flow's testnet3 merchant portal). The customer payment settled on-chain: [`0x39c1af4c6dff998829f379cd29539899594a3d9e1ce354ffebcb1e3a473d5c0f`](https://explorer.testnet3.goat.network/tx/0x39c1af4c6dff998829f379cd29539899594a3d9e1ce354ffebcb1e3a473d5c0f) (block 15710685), independently verified by `apps/payment-worker` against the chain before the run was allowed to transition to `FUNDED`.
2. **Real AI risk classification and deterministic plan compilation.** The proposal returned `MEDIUM` risk and two scenarios; `compileTestPlan()` forced the mandatory `payment-proof-replay` scenario in regardless, producing all three scenarios above.
3. **Real procurement payment.** A native-asset transfer of `1000` wei from the orchestrator signer to the demo-target receiving wallet: [`0x2359fa484377552e5efd9c98bf66036165e90aedcf00e06164fb099d0415a8a5`](https://explorer.testnet3.goat.network/tx/0x2359fa484377552e5efd9c98bf66036165e90aedcf00e06164fb099d0415a8a5) (block 15711069), independently verified by `apps/x402-demo-target`'s `/purchase` route before it issued a receipt.
4. **Real scenario execution.** All three scenarios ran over real HTTP against the live `apps/x402-demo-target` process (reached through a real `cloudflared` tunnel, not loopback) using the earned receipt: `PASS`, `PASS`, `PASS`.
5. **Real signed evidence.** Served publicly at `GET /v1/runs/run_19afc615-5d80-4b0f-895a-34a91dcf78bb/evidence`, three EIP-712-signed `ToolReceipt`s, evidence root and tool-receipt root computed and published to IPFS (`ipfs://bafkreib3id425qnnuyar4lbkc3guuljmobyanauvnkjnoc6jid5o7qfv7i`).
6. **Real on-chain attestation.** [`0x4c4e7dc700398236b2d3fc211adb1252abfcd1f431a679982f252e20a0f958c7`](https://explorer.testnet3.goat.network/tx/0x4c4e7dc700398236b2d3fc211adb1252abfcd1f431a679982f252e20a0f958c7) (block 15711074) to `ShipyardRunRegistry` at `0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd`, status `success`.

## Real bugs found and fixed while producing this run

Getting a human-paced wallet payment through the full pipeline (rather than a scripted instant one) surfaced three real defects, all fixed and covered by tests in the commits from this session:

1. **`apps/payment-worker`**: the reconciliation job's retry budget (8 attempts, 60s-capped backoff ≈ 5 minutes total) was far shorter than a real person takes to open a wallet and confirm a payment. An exhausted "payment not ready" wait was also mislabeled as a generic `UNCLASSIFIED_RECONCILIATION_FAILURE`, indistinguishable from a real bug. Fixed: widened the retry budget to roughly an hour (migration `0007_payment_reconciliation_retry_budget.sql`, backoff cap raised) and gave the timeout its own `PAYMENT_NOT_READY_TIMEOUT` reason code.
2. **`apps/orchestrator-worker`**: the procurement step compared the demo-target's native-asset minimum purchase amount (18-decimal wei) directly against the mandate's tool-budget ceiling (6-decimal USDC atomic units) — a cross-currency unit mismatch that made every real procurement attempt fail with "Demo target minimum purchase amount exceeds the compiled mandate ceiling." Fixed operationally by keeping `DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT` at the small, intentionally symbolic value the procurement leg was always designed to use (`1000`, matching the 2026-08-05 evidence run) rather than the much larger value it had drifted to.
3. **`apps/api-gateway` and `apps/x402-demo-target`**: both were constructed with Fastify's logger disabled (`logger: false`), so unexpected runtime errors were completely invisible — this was the actual root cause of an earlier, separately-investigated `GOAT_FLOW_ORDER_CREATION_FAILED` mystery in this session that otherwise required a throwaway script to diagnose. Fixed: enabled structured logging outside tests.

None of these were visible from outside; all three were found by driving this exact run through a real human payment delay and reading the newly-added error logs.

## Reproduction safeguards

Same disposable, testnet-only signer files as [testnet3-orchestrator-run-2026-08-05.md](./testnet3-orchestrator-run-2026-08-05.md). No new signers were introduced for this run.
