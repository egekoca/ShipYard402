# Business Model

## What is sold

Shipyard402 sells a single, narrow product: **version-scoped, policy-scoped, expiry-bound execution evidence** for one exact x402 service version. A `PASS` means that exact version, tested under that exact named policy, at a recorded time. It is not a general security certificate and does not carry forward to the next release.

## Who pays, for what, when

| Question | Answer |
|---|---|
| Who pays | The requester of a release run — either the service's own operator (pre-release gate) or a downstream integrator who wants third-party-verifiable evidence before committing budget to a service they don't control. |
| For what | One **run**: one test plan (currently the mandatory `payment-proof-replay` scenario, see `docs/state-machine.md`) executed against one exact `targetVersionHash` under one exact `policyHash`. |
| When | Upfront, at quote acceptance — before `ANALYZING` starts. The `FUNDED` state gate (`packages/run-domain`) makes this structural, not a policy: the orchestrator cannot begin work on an unfunded run. |
| How the fee is taken | As one line item inside that upfront payment (`baseOrchestrationFeeAtomic`), not a separate invoice. |

## Revenue mechanics

`packages/quote-engine` computes every quote as a sum of line items (`QuoteEngine.createQuote`), capped by the requester's declared `maximumCustomerBudgetAtomic`. This is implemented and unit-tested, not aspirational. Shipyard's own fee is a **5% take rate** on the pass-through costs below (`feeRateBps: 500`), not a flat charge — it is solved so `baseOrchestrationFeeAtomic / totalAtomicAmount == 5%` for every quote, so a cheap run isn't overcharged and an expensive one isn't undercharged. The numbers currently wired into `apps/api-gateway/src/server.ts` are explicitly marked `pricingStatus: 'HYPOTHESIS'` — placeholder testnet figures, not launch pricing, and deliberately kept minimal:

| Line item | Atomic amount | What it actually is |
|---|---|---|
| `mandatoryToolBudgetAtomic` | 800,000 | Pass-through: pays the target service for the paid call(s) the mandatory scenario makes against it |
| `dynamicToolBudgetAtomic` | 300,000 | Pass-through: headroom for AI-proposed scenarios, clamped by the deterministic compiler (ADR-0006) |
| `modelInfrastructureReserveAtomic` | 100,000 | Covers the OpenAI risk-classification call |
| `chainStorageReserveAtomic` | 50,000 | Covers attestation-transaction gas |
| `riskSupportReserveAtomic` | 100,000 | Contingency buffer |
| `baseOrchestrationFeeAtomic` | 71,052 (derived) | Shipyard's actual take — 5% of the 1,350,000 pass-through total above, the only line that is pure revenue |

Total for the current placeholder configuration: 1,421,052 atomic units (down from an earlier flat-fee version that totaled 4,700,000) — most of that drop is the reserve lines above being cut to more realistic minimums, not just the fee switching from flat to percentage.

`mandatoryToolBudgetAtomic + dynamicToolBudgetAtomic` is reported back to the customer as `refundableToolBudgetAtomic` — the ceiling of what *could* be spent testing the target, not what necessarily will be. Once procurement spends its (typically much smaller) fixed amount, `apps/orchestrator-worker` sends the unspent difference back to the requester as a real ERC20 transfer, checkpointed the same way as the procurement payment and attestation so a resumed run never double-refunds. This is wired but disabled by default (`ORCHESTRATOR_REFUNDS_ENABLED=false`) — see **Known gaps** for why.

Real launch pricing (token, decimals, and actual atomic amounts) is not yet fixed, because it depends on the settlement token GOAT Flow merchant onboarding resolves to.

## Why customers come back

The product is deliberately non-transferable across versions: a `PASS` for `targetVersionHash` A says nothing about version B, and every attestation carries an `expiresAt`. Two independent triggers create recurring, not one-off, demand:

- **Every release** of a service under evaluation needs its own run — this is the natural hook into a CI/CD pipeline ("Autonomous Release Assurance," per the README tagline), not a one-time audit.
- **Expiry**, even without a new release — a customer who wants continuous assurance (e.g. for a compliance or monitoring use case) has to re-run before the previous attestation lapses.

## Can it earn money on its own?

Split by what is actually autonomous today versus what still needs a human:

**Autonomous once a customer is onboarded:** the entire fulfillment loop — quote → fund → `ANALYZING` → ... → `DELIVERED_*` — runs on `apps/orchestrator-worker`'s leased job queue with no human dispatch. The fee is collected as part of the upfront funding step, not invoiced afterward. For a repeat customer with an existing integration (e.g. their CI pipeline calling Shipyard402 on every deploy), no one at Shipyard402 touches a run or its payment. That is genuinely agent-native, self-serve revenue collection for repeat business.

**Not autonomous, and not pretended to be:**
- Acquiring the *first* customer — sales/business development, not code.
- Pricing strategy — `QuotePricingPolicy` is static configuration; nothing adjusts it based on demand, risk, or market data.
- Scenario coverage — only one mandatory scenario type exists (`payment-proof-replay`). Selling evidence for a new class of vulnerability requires engineering work, not just a new AI prompt.
- The one-time GOAT Flow merchant KYC/onboarding step, which gates all of the above.

## Current status: real vs. simulated

| Claim | Status |
|---|---|
| Fee computation | Real — implemented, unit-tested, exercised through the frontend quote form |
| Autonomous run execution once funded | Real — proven end-to-end against GOAT Testnet3 (`docs/evidence/testnet3-orchestrator-run-2026-08-05.md`) |
| Real customer payment collection | **Not yet live** — blocked on GOAT Flow Testnet3 merchant onboarding, an external step outside this codebase |
| Refund of unspent tool budget | Real ERC20 transfer implemented and checkpointed — **disabled by default** (`ORCHESTRATOR_REFUNDS_ENABLED=false`) since the signer holds no real customer balance to refund from until GOAT Flow merchant onboarding is real |
| Revenue collected to date | **$0.** One real run exists; it is first-party (Shipyard's own verification run) and is explicitly excluded from counting as revenue or traction, consistent with the self-dealing disclosure in `docs/threat-model.md` |

## Path to first real dollar

1. Complete GOAT Flow Testnet3 (then Mainnet) merchant onboarding — human action, outside this codebase.
2. Replace the `HYPOTHESIS` pricing constants with real numbers denominated in whatever token that onboarding resolves to.
3. Flip `ORCHESTRATOR_REFUNDS_ENABLED=true` once the signer wallet actually custodies real customer funds to refund from.
4. Find one design-partner customer — a real x402 service operator willing to pay for a real run — before claiming any traction.
