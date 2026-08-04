# ADR-0019: Follow the current GOAT Flow environment origins

Status: accepted, 2026-08-04.

## Context

ADR-0017 selected the environment table then published at the former x402 documentation route. That route now redirects to the GOAT Flow Quick Start. The current official GOAT documentation pins `GOATNetwork/x402` commit `8f0564354ae5ce1afa736d481ea8748317b147ee`, whose API reference defines the authenticated Flow API origins as `https://flow-api.goat.network` for mainnet and `https://flow-api.testnet3.goat.network` for Testnet3. The same reference keeps merchant credentials and token capabilities environment-specific.

## Decision

ADR-0017 is superseded. Network configuration exposes `flowApiUrl`, and credential-backed adapters select the exact origin from the reviewed `mainnet` or `testnet3` environment. Arbitrary Flow API origin substitution remains prohibited. Mainnet and Testnet3 merchant IDs, API credentials, token contracts, receiving addresses, and evidence must never be mixed.

## Consequences

The testnet rollout can use the current authenticated Flow API without weakening mainnet configuration. Changes to these origins require another official-source comparison and ADR. Existing runtime configuration using the superseded `x402-api*` origins will fail validation instead of silently switching environments.
