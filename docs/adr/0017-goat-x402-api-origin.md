# ADR-0017: Use the current GOAT x402 API origins

Status: superseded by ADR-0019, 2026-08-04.

## Context

The pinned `goatflow-sdk-server` 0.3.0 README still shows the legacy production origin `https://flow-api.goat.network`. The current official GOAT Developer Quick Start identifies `https://x402-api.goat.network` as the production API and `https://x402-api-lx58aabp0r.testnet3.goat.network/` as the Testnet3 API. The SDK package remains at 0.3.0 and its request paths match the current documented API schema.

## Decision

Official environment documentation takes precedence over the stale SDK README example. Network configuration exposes `x402ApiUrl` and the merchant adapter uses the current production origin. Runtime configuration uses the official `GOATX402_*` environment variable names. Arbitrary API-origin overrides are not accepted in production.

## Consequences

The old `GOAT_FLOW_API_URL` and `GOAT_FLOW_*` environment names are removed before production deployment. A future SDK release may update its README, but endpoint changes still require comparison with official GOAT documentation and a reviewed configuration change.
