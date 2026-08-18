# BOT Chain testnet first fully real end-to-end run — 2026-08-17

## Scope

This record proves the complete `PAYMENT_REQUIRED → DELIVERED_PASS` pipeline on **BOT Chain testnet
(chain 968)** with no simulated legs: a real customer payment verified directly on-chain by the
`bot-chain-direct` merchant adapter, real AI risk classification, a real x402 `exact` procurement
payment settled on BOT Chain, real scenario execution over a public HTTPS tunnel, and a real signed
attestation written to the BOT Chain registry.

It does not prove third-party traction. The customer wallet, the merchant receiving address and the
target service are all first-party, disposable testnet wallets — this is a self-test proving the
mechanism on a second chain, not external revenue. Mainnet is out of scope.

## Run

| Field | Value |
| --- | --- |
| Run ID | `run_ba50254c-c30a-44b8-b70c-5271747593cc` |
| Final status | `DELIVERED_PASS` (result `PASS`) |
| Chain | BOT Chain testnet, `968`, RPC `https://rpc.bohr.life`, explorer `https://scan.bohr.life` |
| Settlement asset | `ShipyardTestToken` (`SHIPTEST`, 18 decimals) at `0x1213319c60D2749409BBeA32e79450464F5dFd09` |
| Quote total | `1421052` atomic SHIPTEST |
| Risk level (AI) | `MEDIUM` |
| Scenarios executed | `payment-proof-replay`, `unpaid-access-denial`, `tampered-receipt-rejection` — all `PASS` |

## On-chain transactions

| Leg | Transaction | Block |
| --- | --- | --- |
| Customer payment (1,421,052 SHIPTEST → merchant receiving address) | [`0x3089…55cf`](https://scan.bohr.life/tx/0x3089563b28d0fe7d0ae001a8a2f820b29ecee409b44589f5d3be2042fe2a55cf) | 20173524 |
| Procurement, x402 `exact` settlement (1,000 SHIPTEST → target's `payTo`) | [`0x8e05…3618`](https://scan.bohr.life/tx/0x8e054849024ff4d020ee2f59be31dd5d7f8ce9ccc8559b811607591455b03618) | 20174285 |
| Attestation `recordRun` → `ShipyardRunRegistry` | [`0x096e…f74b`](https://scan.bohr.life/tx/0x096efa3f4d832a348576603ee3533a4cb807c230054ec354eafdf75d324cf74b) | 20174292 |

Registry `0xC3B9Bf98E1D1Ab16553bCfDB50312313Db61cb8E`, attestor `0x0fb8aad3bDd981E47E8b7f914a88bcbAdDd31cE2`,
attestation receipt status `1`, gas used `509969`, expiry `2026-09-16T11:26:04Z`.

Supporting setup transactions the same day: attestor authorization
[`0x8737…3e22`](https://scan.bohr.life/tx/0x87373e092c2cdac4158ceea6f1865744285387439d08f7d1f27411a7c7cb3e22)
and settlement-token mints to the orchestrator and customer wallets.

## What is real

1. **Real customer payment, verified on-chain, no merchant API.** The `bot-chain-direct` adapter
   issues an x402 challenge (`eip155:968`), the customer wallet sends the ERC-20 transfer itself,
   and `apps/payment-worker` verifies the `Transfer` log against the order before the run may reach
   `FUNDED`. Nothing about the payment is taken on trust from the frontend.
2. **Real AI risk classification and deterministic compilation.** The proposal returned `MEDIUM` and
   two scenarios; `compileTestPlan()` forced the mandatory `payment-proof-replay` in regardless,
   producing all three scenarios above.
3. **Real x402 `exact` procurement on BOT Chain.** `apps/x402-demo-target` advertised a 402 with the
   SHIPTEST asset and its EIP-712 domain; the orchestrator signed an EIP-3009
   `transferWithAuthorization` and the target settled it on-chain before delivering.
4. **Real scenario execution.** All three scenarios ran over real HTTP against the live target
   through a public `cloudflared` tunnel — not loopback.
5. **Real evidence and attestation.** Evidence root `0x2bf8…4ddf`, tool-receipt root `0xbe1c…f120`,
   published to IPFS (`ipfs://bafkreihusje4zmg2bhj65fjrso5rztph4wsxsdyts3bmeb4dsvr7clsuje`), and the
   signed verdict recorded on BOT Chain in the transaction above.

## Reproducibility

A second run was driven end-to-end by `scripts/testnet/botchain-selftest-run.mjs` with no manual
step, on the fixed code: `run_9ebac14c-5cad-471d-8bf0-f981ff2388ba`, `QUOTED → PAYMENT_REQUIRED →
FUNDED → ANALYZING → EXECUTING → ATTESTING → DELIVERED_PASS` in about 27 seconds. Its customer
payment is [`0xd785…c2c5`](https://scan.bohr.life/tx/0xd7855cf4aabea427800ad134177aeffae3554a3cb56e7ae93ae20789cc51c2c5)
and its attestation is [`0x9671…eaf4`](https://scan.bohr.life/tx/0x96712841f04871d18fd17e84be746b54f8eec61f4fd2cc2e8a544f255afbeaf4).
The first run above needed one manual `payment-tx` resubmission because the snapshot bug rejected
the original call; the second needed none.

## Real bugs found and fixed while producing this run

1. **`payment_orders.order_snapshot` shape collision (blocking).** The GOAT Flow store writes the
   merchant order at the top level; the BOT Chain store wraps it as `{ order, … }` because it also
   has to remember the submitted transaction hash and proof. `PostgresRunRepository` and
   `PostgresPaymentReconciliationStore` both parsed that column with the *Flow* schema, so in BOT
   mode every run load threw a `ZodError` — `POST /v1/runs/:id/payment-tx` answered `500` and
   reconciliation could never confirm a payment. Fixed by parsing the column shape-tolerantly
   (`packages/persistence-postgres/src/merchant-order-snapshot.ts`), by preserving the wrapper on
   write (`jsonb_set` instead of replacing the document), and by reading the order deadline from
   either shape in the expiry query.
2. **A logging call could kill the payment worker.** `console.error(msg, error)` in the
   reconciliation handler crashed inside `util.inspect` for some adapter errors, so instead of
   dead-lettering one job the whole worker exited with a bare `SAFE_RUNTIME_FAILURE`. Fixed by
   logging a flattened string, and by including the failure message in the worker's exit log the way
   `apps/orchestrator-worker` already did.
3. **The demo target was pinned to GOAT.** `apps/x402-demo-target` resolved its chain only through
   `@shipyard402/goat-network-config`, so it could not act as a BOT Chain target at all. It now
   takes the same `NETWORK` switch the orchestrator uses, and serves its own `/openapi.json` — which
   is what onboarding hashes into `targetVersionHash`.

## Reproduction

```bash
# operator-run, testnet only
node scripts/testnet/authorize-attestor-botchain.mjs
node scripts/testnet/mint-test-token-botchain.mjs <0xRecipient> <amount>
node scripts/testnet/fund-botchain-wallet.mjs <0xRecipient> <botAmount>
TARGET_BASE_URL=<public https url of the demo target> node scripts/testnet/botchain-selftest-run.mjs
```

The stack for this run was a BOT-scoped environment file (`.env.botchain`, gitignored) against a
separate `shipyard_bot` database and separate ports, so the running GOAT Testnet3 stack was never
touched and neither worker set could claim the other's jobs.
