# GOAT → BNB bridge-then-pay PoC

Shipyard402 can fund a controlled BNB Chain x402 v2 purchase from GOAT mainnet instead of relying
on a permanently prefunded destination wallet. The route is:

1. Lock a run-specific procurement intent and spend ceiling.
2. Bridge GOAT USDT through Stargate V2 / LayerZero.
3. Verify the LayerZero delivery and the canonical BNB USDT receipt on BNB Chain.
4. Grant the x402 Permit2 proxy only the exact bounded allowance required for the purchase.
5. Sign the x402 `exact` payment authorization and call the protected BNB resource.
6. Persist both bridge transaction hashes and the BNB settlement hash in the run evidence trail.

## Fixed route and contracts

| Item | Value |
| --- | --- |
| Source network | GOAT mainnet (`eip155:2345`) |
| Source USDT | `0xE1AD845D93853fff44990aE0DcecD8575293681e` (6 decimals) |
| GOAT Stargate USDT OFT | `0x549943e04f40284185054145c6E4e9568C1D3241` |
| Source LayerZero EID | `30361` |
| Destination network | BNB Smart Chain mainnet (`eip155:56`) |
| Destination USDT | `0x55d398326f99059fF775485246999027B3197955` (18 decimals) |
| BNB Stargate USDT OFT | `0x138EB30f73BC423c6455C53df6D89CB01d9eBc63` |
| Destination LayerZero EID | `30102` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| x402 exact Permit2 proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` |

The adapter converts the 6-decimal source amount into the 18-decimal destination representation
and rejects a delivery that is not the canonical BNB settlement asset or does not cover the
configured x402 price.

### USDC route (alternative to USDT)

The same bridge-then-pay flow runs in USDC, so a run funded in GOAT USDC never has to be swapped to
USDT first. Select it with `CROSS_CHAIN_PROCUREMENT_MODE=goat-bnb-usdc` and configure the BNB target
with `BNB_X402_SETTLEMENT_ASSET=USDC`. All four contract addresses below were taken from Stargate's
official V2 mainnet-contracts reference and then verified on-chain (each pool's live `token()`
returns the USDC below; `sharedDecimals()` is 6). GOAT's `StargatePoolUSDT` on that same reference
matches this file's USDT OFT, which is how the source was trusted.

| Item | Value |
| --- | --- |
| Source USDC (GOAT) | `0x3022b87ac063DE95b1570F46f5e470F8B53112D8` (6 decimals) |
| GOAT Stargate USDC OFT | `0xbbA60da06c2c5424f03f7434542280FCAd453d10` |
| Destination USDC (BNB) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 decimals) |
| BNB Stargate USDC OFT | `0x962Bd449E630b0d928f308Ce63f1A21F02576057` |

Endpoints are shared with the USDT route (source EID `30361`, destination EID `30102`).

## Read-only preflight (run before any funded run)

```
pnpm --filter @shipyard402/stargate-bridge-adapter preflight
```

This moves no funds and prints no secrets (only derived public addresses). It verifies both USDC
pools are live and correctly bound, that the GOAT signer holds enough USDC for the bridge amount and
enough native gas, and -- once the cross-chain env is set -- that the BNB payer has gas, the BNB
target answers a 402, and the amounts sit within their ceilings. Treat a `NO-GO` verdict as blocking.
The pure evaluator behind it (`evaluateCrossChainPreflight`) is unit-tested; the script is the thin
I/O shell that gathers the facts.

## Wallet roles

- The GOAT orchestrator signer pays the Stargate transaction and must hold GOAT gas plus source
  USDT.
- The BNB payer is the bridge recipient and signs the x402 authorization. It needs a small BNB
  balance for the exact Permit2 approval.
- The facilitator submits the x402 settlement and needs BNB gas. Keep it separate from the payer.
- The merchant `payTo` address receives canonical BNB USDT and does not need to sign the purchase.

## Safe local preparation

1. Copy the cross-chain section from `.env.example` and leave
   `CROSS_CHAIN_PROCUREMENT_MODE=disabled` while reviewing addresses and atomic-unit ceilings.
2. Start the controlled target with `pnpm dev:bnb-x402-target`. Its facilitator is deliberately
   loopback-only.
3. Expose only the target port through a public HTTPS deployment or tunnel. The orchestrator's
   normal target policy rejects localhost and plain HTTP; do not weaken this check.
4. Register the resulting HTTPS resource as the BNB target and set the same URL in
   `BNB_X402_ENDPOINT`.
5. Confirm source and destination wallet balances and ceilings by running the read-only preflight
   above until every check is `PASS` (thin-gas `WARN` is non-blocking but should be resolved).
6. Set `CROSS_CHAIN_PROCUREMENT_MODE` to `goat-bnb-usdc` (or `goat-bnb-usdt`) only for the explicitly
   approved funded run, matching `BNB_X402_SETTLEMENT_ASSET` on the target.

## Resume and failure behavior

Bridge submission is idempotent per run and checkpointed before waiting for delivery. A worker
restart resumes from the stored transfer rather than submitting a second bridge. Once the source
send has been attempted, an ambiguous result fails closed and cannot be automatically resubmitted.
Pending LayerZero delivery schedules a later worker attempt without consuming the retry budget.
The BNB payment authorization and settlement are also checkpointed, and ambiguous settlement is
sent to manual review instead of retried blindly.

No command in the normal test/build workflow moves funds. A live run requires complete mainnet
configuration and explicit approval immediately before the bridge transaction is signed.
