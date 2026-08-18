# BOT Chain marketplace + end-to-end proof — 2026-08-18

The dashboard now merges the GOAT/BNB catalog from the primary API with the BOT Chain catalog from
the BOT-specific API. A selected listing keeps its backend identity through quote creation, run
creation, customer-payment submission, polling, history, and standalone run links. Browser session
tokens are stored separately for both APIs.

## Public BOT testnet target

- Chain: BOT Chain testnet (`968`)
- Marketplace service: `service:x402-demo-target:botchain-testnet`
- Target: `https://cabinets-pentium-screensavers-excellent.trycloudflare.com/paid/resource`
- OpenAPI: `https://cabinets-pentium-screensavers-excellent.trycloudflare.com/openapi.json`
- Settlement token: `0x1213319c60D2749409BBeA32e79450464F5dFd09`
- The target answered `/health` with HTTP 200 and `/paid/resource` with a real x402 payment
  challenge.

The quick-tunnel hostname is temporary. `pnpm local:botchain-target:up` restarts the target, opens a
new HTTP/2 tunnel, and republishes the stable marketplace service ID with the new URL.

## Real successful run

- Run: `run_e462d5eb-1d11-4925-92e6-0ea8809338bb`
- Result: `DELIVERED_PASS`
- Customer payment:
  `0x7b4e26bc975853322ff6f93adcae44e34af08208b3e924d58e1c738d7d2e9efd`
- Customer payment explorer:
  `https://scan.bohr.life/tx/0x7b4e26bc975853322ff6f93adcae44e34af08208b3e924d58e1c738d7d2e9efd`
- Attestation:
  `0xf2dd183cf8ea3b9d4f0cebcb98e80c3a18382a570dc215dfede75f301d73e399`
- Attestation explorer:
  `https://scan.bohr.life/tx/0xf2dd183cf8ea3b9d4f0cebcb98e80c3a18382a570dc215dfede75f301d73e399`
- Registry: `0xC3B9Bf98E1D1Ab16553bCfDB50312313Db61cb8E`

Observed state sequence:

`PAYMENT_REQUIRED → ANALYZING → PROCURING → ATTESTING → DELIVERED_PASS`

## Verification

- Dashboard TypeScript check: passed
- Dashboard Vitest suite: 149/149 passed
- Real BOT Chain testnet payment: confirmed in block `20296136`
- Real BOT Chain registry attestation: persisted for chain `968`

No BNB mainnet transaction or mainnet fund was used in this change.
