# ADR-0015: Independently deploy frontend and backend

Status: accepted, 2026-08-04.

## Context

The web interface is internet-facing, while merchant HMAC credentials, PostgreSQL, payment receipts, payer authority, and attestor authority are high-trust assets. A Next.js server that imports backend packages would make accidental secret exposure and confused deployment roles more likely.

## Decision

`apps/web-dashboard` and `apps/api-gateway` are separate deployable applications. The dashboard may depend only on `packages/public-api-client` and browser-safe libraries. The GOAT Flow server SDK, database drivers, worker modules, and signer abstractions are backend-only. Browser access to the API uses an explicit CORS origin allowlist with credentials disabled.

## Consequences

Frontend releases cannot directly mutate state, access payment credentials, or sign transactions. Public DTO changes must cross an explicit API-client boundary. Production will deploy API and workers with distinct service identities and network policies.
