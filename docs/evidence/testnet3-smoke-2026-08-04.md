# GOAT Testnet3 smoke evidence — 2026-08-04

## Scope

This record proves that an isolated test-only signer received native faucet gas and deployed the current `ShipyardRunRegistry` bytecode to GOAT Testnet3. It does not prove an x402 payment, a customer run, tool procurement, revenue, traction, an assurance result, or any mainnet activity.

## Network and signer

| Field | Value |
| --- | --- |
| Environment | GOAT Testnet3 |
| Chain ID | `48816` (`0xbeb0`) |
| RPC | `https://rpc.testnet3.goat.network` |
| Explorer | `https://explorer.testnet3.goat.network` |
| Test-only signer | `0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10` |

The signer is marked `goat-testnet3-only`; the local signer file is mode `0600` and ignored by Git. It must never be funded or reused on mainnet.

## Faucet transaction

| Field | Value |
| --- | --- |
| Transaction | [`0x241a…ebc2`](https://explorer.testnet3.goat.network/tx/0x241a3f593eba16472e1cfc49a5af6374a144ac6c3a7e4b37dd0ed750b735ebc2) |
| Block | `15658346` |
| Result | Success |
| Native amount | `0.000007 BTC` (`7000000000000` wei) |
| Timestamp | `2026-08-04T13:07:10Z` |

The faucet supplied native gas BTC only. At capture time, the signer held zero units of the documented Testnet3 GOAT utility token at `0xbC10000000000000000000000000000000000001`. This is not an x402 payment balance.

## Registry deployment

| Field | Value |
| --- | --- |
| Contract | [`0x07f6…8ddd`](https://explorer.testnet3.goat.network/address/0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd) |
| Deployment transaction | [`0x137a…94e`](https://explorer.testnet3.goat.network/tx/0x137ad796c82121460409fe78efe6baf0fc249089e2c64f61be8937e741c4594e) |
| Block | `15658461` |
| Owner | `0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10` |
| Gas used | `3395843` |
| Fee | `0.000000441483360901 BTC` (`441483360901` wei) |
| Runtime bytecode hash | `0x26b9bd3c15f84386816712a9f853f877c1035cc25f0f1128fa4c7c2d7e16c721` |
| Explorer source status | Not yet verified |

No run attestation was submitted: a registry entry without a real customer payment and signed tool evidence would create misleading evidence.

## Reproduction safeguards

```bash
corepack pnpm testnet:status
corepack pnpm testnet:deploy:registry
```

The deployment command requires the exact Testnet3 RPC and chain ID, verifies signer/address consistency, caps projected deployment cost at `0.000002 BTC`, and reuses a valid local deployment record instead of broadcasting a duplicate deployment.

## Open prerequisites for a real x402 test

- Separate Testnet3 GOAT Flow merchant onboarding and credentials.
- A merchant-reviewed Testnet3 payment token, recipient, decimals, and amount bounds.
- Test payment-token funding from an official/merchant-supported route.
- An external or independently operated paid tool provider.
- Explorer source verification for the testnet registry.

## Official references

- [GOAT Flow Quick Start](https://docs.goat.network/docs/build/goat-flow/flow-quick-start)
- [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet)
- [GOAT Networks](https://docs.goat.network/docs/build/network-information)
- [Contracts on GOAT](https://docs.goat.network/docs/build/contracts)
- [Pinned GOAT Flow API reference](https://github.com/GOATNetwork/x402/blob/8f0564354ae5ce1afa736d481ea8748317b147ee/docs/goat-flow-api-reference.md)
