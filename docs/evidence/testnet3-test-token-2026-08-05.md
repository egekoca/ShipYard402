# GOAT Testnet3 test ERC-20 evidence — 2026-08-05

## Scope

This record proves a real, deployed, mintable ERC-20 (`ShipyardTestToken`, symbol `SHIPTEST`) exists on GOAT Testnet3, and that the exact ERC-20 `transfer` calldata encoding used by `apps/web-dashboard`'s wallet-pay flow (`apps/web-dashboard/src/lib/goat-wallet.ts`) moves a real balance on-chain. It exists to exercise the wallet-connect-and-pay UI end to end while real GOAT Flow merchant onboarding (the actual x402 settlement asset) is still pending. **`SHIPTEST` has no value, is not the token GOAT Flow will settle real runs in, and must never be deployed to or referenced on Mainnet.**

## Network and signer

| Field | Value |
| --- | --- |
| Environment | GOAT Testnet3 |
| Chain ID | `48816` (`0xbeb0`) |
| RPC | `https://rpc.testnet3.goat.network` |
| Test-only signer / token owner | `0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10` |

## Token deployment

| Field | Value |
| --- | --- |
| Contract | [`0x69B2…8a33a`](https://explorer.testnet3.goat.network/address/0x69B20ec2BD44A2CD912827e50c00c0e2Dbe8a33a) |
| Deployment transaction | [`0xf00d…03fe005`](https://explorer.testnet3.goat.network/tx/0xf00d3f063626eab9a3804340bae1cdd11ed8b50147962427504de39b403fe005) |
| Block | `15685490` |
| Symbol / decimals | `SHIPTEST` / `18` |
| Gas used | `609310` |
| Fee | `0.00000007921456517 BTC` |

## Mint

| Field | Value |
| --- | --- |
| Transaction | [`0xa27e…080719b`](https://explorer.testnet3.goat.network/tx/0xa27e96e1ec4a2f214f123c439d46ff3f03482a851bae634c7e3370117080719b) |
| Minted | `100 SHIPTEST` to the owner wallet |

## Real transfer using the frontend's exact calldata encoding

`apps/web-dashboard/src/lib/goat-wallet.ts`'s `encodeErc20Transfer` was exercised directly (same selector `0xa9059cbb`, same address/amount padding) to send `5 SHIPTEST` from the owner wallet to a disposable test recipient (`0x2000000000000000000000000000000000000002`), the same shape of transaction a customer's connected wallet sends when pressing "Pay" in `WalletPayPanel`.

| Field | Value |
| --- | --- |
| Transaction | [`0x7331…54e31a7`](https://explorer.testnet3.goat.network/tx/0x7331c86c25eb50edef34f8992a229c36155dae7beec6429c392113bb054e31a7) |
| Gas used | `51376` |
| Recipient balance after | `5000000000000000000` (`5 SHIPTEST`, independently read back via `balanceOf`) |

The calldata encoding was also checked byte-for-byte against ethers' own ABI encoder (`Interface.encodeFunctionData`) for an identical `transfer(address,uint256)` call and matched exactly.

## What this does not prove

- Not an x402 payment, not a GOAT Flow order, not a funded run.
- Not revenue or traction (`SHIPTEST` has no value).
- Not a Mainnet activity of any kind.

## Reproducing

```bash
corepack pnpm testnet:wallet:create
corepack pnpm contracts:test          # forge test, includes ShipyardTestTokenTest
cd contracts && forge build && cd ..
node scripts/testnet/deploy-test-token.mjs
node scripts/testnet/mint-test-token.mjs <0xRecipient> 100
```
