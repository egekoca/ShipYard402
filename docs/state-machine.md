# Run State Machine

All commands carry an idempotency key and expected revision. `run_events(run_id, idempotency_key)` and `(run_id, revision)` are unique. Queue retries repeat the same command key. A revision conflict reloads state; it never blindly reapplies an economic action.

| Transition | Actor | Precondition | Event | Retry / timeout / recovery |
|---|---|---|---|---|
| DRAFT → QUOTED | Quote Engine | Valid, unexpired capability-backed quote | `run.transitioned` | Idempotent; quote TTL; expire before payment |
| QUOTED → PAYMENT_REQUIRED | Merchant Gateway | Persisted dappOrderId and runtime capability | `payment.order_created` | Reuse dappOrderId; bounded retry; reconcile before create |
| PAYMENT_REQUIRED → FUNDED | Payment Reconciler | Confirmed/invoiced order and matching on-chain Transfer | `payment.verified` | Poll idempotently; expiry → EXPIRED; ambiguity stays pending |
| FUNDED → ANALYZING | Orchestrator | Unique customer proof bound to run | `analysis.started` | Safe queue retry; deadline failure continues to evidence |
| ANALYZING → PLAN_COMPILED | Policy Engine | Structured AI plan plus mandatory scenarios | `plan.compiled` | Validation retry only; invalid plan → evidence/INCONCLUSIVE |
| PLAN_COMPILED → PROCURING | Procurement Worker | Immutable mandate | `procurement.started` | Safe retry before spend; every purchase has its own key |
| PROCURING → EXECUTING | Procurement/Execution Worker | Required paid tool deliveries reconciled | `execution.started` | Provider timeout may replan within budget |
| PROCURING → REPLANNING | Orchestrator | Provider failure or conflicting capability | `replan.requested` | Bounded by tool/retry/deadline limits |
| PROCURING → EVIDENCE_BUILDING | Procurement/System | Budget/deadline/provider exhaustion | `execution.incomplete` | Result must become INCONCLUSIVE, never PASS |
| EXECUTING → REPLANNING | Orchestrator | Conflicting deterministic/provider evidence | `replan.requested` | Additional spend requires mandate/approval |
| EXECUTING → EVIDENCE_BUILDING | Execution Worker | Scenario receipts and deterministic aggregation | `execution.completed` | Receipt writes idempotent by scenario/run |
| REPLANNING → PROCURING | Policy/Procurement | Recompiled plan still requires tools | `plan.recompiled` | Same hard mandate ceilings remain |
| REPLANNING → EXECUTING | Policy/Execution | No extra purchase required | `plan.recompiled` | Existing paid proof cannot be charged again |
| REPLANNING → EVIDENCE_BUILDING | Orchestrator/System | No safe/economic path remains | `replan.exhausted` | INCONCLUSIVE evidence |
| EVIDENCE_BUILDING → ATTESTING | Evidence Worker | Canonical pack, verified signatures and roots | `evidence.built` | Rebuild must reproduce identical root |
| ATTESTING → DELIVERED_* | Attestor | Mainnet registry receipt or explicit attestation policy | `attestation.confirmed` | Same run signature may be relayed; run/proof cannot duplicate |
| DRAFT/QUOTED/PAYMENT_REQUIRED → CANCELLED | Requester/System | No verified customer funding | `run.cancelled` | Idempotent terminal |
| DRAFT/QUOTED/PAYMENT_REQUIRED → EXPIRED | System | Quote/order deadline passed without funding | `run.expired` | Idempotent terminal |

After `FUNDED`, cancellation or silent expiry is not allowed. Failures are documented through evidence and delivered as `FAIL` or `INCONCLUSIVE`. Every delivered state and `CANCELLED`/`EXPIRED` is terminal; spending is forbidden.
