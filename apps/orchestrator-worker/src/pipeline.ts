import type { CompiledTestPlan, RiskClassification } from '@shipyard402/risk-classifier';
import { transitionRun, type RunActor, type RunStatus } from '@shipyard402/run-domain';

import { canBuildToolReceipt } from './evidence-builder.js';
import { runAttestationPhase } from './pipeline/attestation-phase.js';
import {
  BridgeDeliveryPendingError,
  CrossChainSettlementAmbiguousError,
  OrchestratorPipelineError,
  PaymentSendAmbiguousError,
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
} from './pipeline/errors.js';
import { runEvidencePhase } from './pipeline/evidence-phase.js';
import { runExecutionPhase } from './pipeline/execution-phase.js';
import { runProcurementPhase } from './pipeline/procurement-phase.js';
import {
  resolveCrossChainPayer,
  runCrossChainProcurementPhase,
  targetIsRemote,
} from './pipeline/cross-chain-procurement-phase.js';
import { runRiskAnalysisPhase } from './pipeline/risk-analysis-phase.js';
import type { OrchestratorPipelineDependencies, PipelineResult, ScenarioResult } from './pipeline/types.js';

// Re-exported so every existing `from './pipeline.js'` import elsewhere in this app (worker.ts,
// main.ts, the test suites) keeps working unchanged -- the split below is an internal
// reorganization, not a change to this module's public surface.
export {
  BridgeDeliveryPendingError,
  CrossChainSettlementAmbiguousError,
  OrchestratorPipelineError,
  PaymentSendAmbiguousError,
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
};
export type {
  AttestationStorePort,
  CheckpointStorePort,
  DemoTargetConfig,
  EvidencePackStorePort,
  OrchestratorPipelineDependencies,
  PipelineResult,
} from './pipeline/types.js';

/**
 * Statuses this pipeline can (re)enter and drive forward. A job may be re-claimed after a crash
 * or a transient failure at any of these statuses — the pipeline resumes from whatever the run's
 * persisted status and checkpoint already reflect, rather than requiring a fresh FUNDED run.
 */
const RESUMABLE_STATUSES = new Set<RunStatus>([
  'FUNDED',
  'ANALYZING',
  'PLAN_COMPILED',
  'PROCURING',
  'EXECUTING',
  'EVIDENCE_BUILDING',
  'ATTESTING',
]);

const STATUS_ORDER: readonly RunStatus[] = [
  'FUNDED',
  'ANALYZING',
  'PLAN_COMPILED',
  'PROCURING',
  'EXECUTING',
  'EVIDENCE_BUILDING',
  'ATTESTING',
];

/**
 * Drives one run through its whole pipeline (risk analysis → procurement → execution → evidence →
 * attestation, each in its own module under ./pipeline/), advancing the run's persisted status
 * one step at a time and checkpointing spend-once side effects as they happen so a re-claimed job
 * resumes from wherever it left off instead of repeating anything.
 */
export async function runOrchestratorPipeline(
  runId: string,
  deps: OrchestratorPipelineDependencies,
): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  const record = await deps.runRepository.findById(runId);
  if (!record) throw new Error(`Run not found: ${runId}`);
  if (!RESUMABLE_STATUSES.has(record.aggregate.status)) {
    throw new RunNotReadyForOrchestrationError(record.aggregate.status);
  }
  const quote = await deps.quoteRepository.findById(record.quoteId);
  if (!quote) throw new Error(`Quote not found for run ${runId}: ${record.quoteId}`);
  const targetVersionHash = quote.request.targetVersionHash as `0x${string}`;
  const policyHash = quote.request.policyHash as `0x${string}`;
  if (!record.customerPaymentProofHash || !record.customerPaymentAtomic) {
    throw new Error(`Run ${runId} is FUNDED but is missing its recorded customer payment`);
  }
  const customerPaymentProofHash = record.customerPaymentProofHash;
  const customerPaymentAtomic = record.customerPaymentAtomic;
  const quoteId = record.quoteId;
  const requestIdempotencyKey = record.requestIdempotencyKey;

  let current = record.aggregate;
  let advancedPastFunded = current.status !== 'FUNDED';
  const checkpoint = await deps.checkpointStore.load(runId);

  // Resuming: skip re-transitioning past whatever the run's persisted status already reflects.
  async function advance(actor: RunActor, to: RunStatus): Promise<void> {
    if (STATUS_ORDER.indexOf(current.status) >= STATUS_ORDER.indexOf(to)) return;
    const result = transitionRun(current, {
      actor,
      expectedRevision: current.revision,
      idempotencyKey: `orchestrator:${runId}:${to}`,
      occurredAt: now().toISOString(),
      to,
    });
    current = result.run;
    advancedPastFunded = true;
    if (!result.event) return;
    await deps.runRepository.save(
      { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
      result.run.revision - 1,
    );
  }

  try {
    await advance('ORCHESTRATOR', 'ANALYZING');
    const { plan, proposal } = await runRiskAnalysisPhase(deps, runId, checkpoint, quote, targetVersionHash);

    await advance('POLICY_ENGINE', 'PLAN_COMPILED');

    await advance('PROCUREMENT_WORKER', 'PROCURING');
    const crossChainPayer = resolveCrossChainPayer(deps, quote);
    // A target on another chain that this worker has no payer for is refused outright. Falling
    // through to the home-chain payer would sign an authorization naming the wrong chain, which the
    // target can never settle -- a wasted run that looks like the target's fault.
    if (!crossChainPayer && targetIsRemote(deps, quote)) {
      throw new ProcurementDeniedError(['NO_PAYER_FOR_TARGET_CHAIN']);
    }
    const { purchaseAmount, paymentTransactionHash, purchaseReceipt, paymentHeaderName } = crossChainPayer
      ? await runCrossChainProcurementPhase(deps, crossChainPayer, runId, checkpoint, plan, quote, current.status, now)
      : await runProcurementPhase(deps, runId, checkpoint, plan, quote, current.status, now);

    await advance('PROCUREMENT_WORKER', 'EXECUTING');
    const { scenarioResults, startedAt, completedAt } = await runExecutionPhase(
      deps,
      runId,
      checkpoint,
      plan,
      quote,
      targetVersionHash,
      policyHash,
      purchaseReceipt,
      paymentTransactionHash,
      paymentHeaderName,
      purchaseAmount,
      now,
    );

    await advance('EXECUTION_WORKER', 'EVIDENCE_BUILDING');
    const { evidencePack, evidenceURI, overallResult } = await runEvidencePhase(
      deps,
      runId,
      quote,
      targetVersionHash,
      policyHash,
      plan,
      proposal,
      scenarioResults,
      startedAt,
      completedAt,
      now,
    );

    await advance('EVIDENCE_WORKER', 'ATTESTING');
    const { attestationTransactionHash } = await runAttestationPhase(
      deps,
      runId,
      checkpoint,
      quote,
      targetVersionHash,
      policyHash,
      customerPaymentProofHash,
      customerPaymentAtomic,
      evidencePack,
      evidenceURI,
      purchaseAmount,
      completedAt,
      overallResult,
      now,
    );

    // DELIVERED_*
    const finalStatus: RunStatus =
      overallResult === 'PASS'
        ? 'DELIVERED_PASS'
        : overallResult === 'FAIL'
          ? 'DELIVERED_FAIL'
          : 'DELIVERED_INCONCLUSIVE';
    if (current.status !== finalStatus) {
      const result = transitionRun(current, {
        actor: 'ATTESTOR',
        expectedRevision: current.revision,
        idempotencyKey: `orchestrator:${runId}:${finalStatus}`,
        occurredAt: now().toISOString(),
        to: finalStatus,
      });
      current = result.run;
      if (result.event) {
        await deps.runRepository.save(
          { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
          result.run.revision - 1,
        );
      }
    }

    return { runId, finalStatus, attestationTransactionHash };
  } catch (error) {
    if (
      error instanceof ProcurementDeniedError ||
      error instanceof PaymentSendAmbiguousError ||
      error instanceof BridgeDeliveryPendingError ||
      error instanceof CrossChainSettlementAmbiguousError
    ) {
      throw error;
    }
    throw new OrchestratorPipelineError(`Orchestrator pipeline failed for run ${runId}`, advancedPastFunded, {
      cause: error,
    });
  }
}

/**
 * Statuses a run can be finalized from after a terminal failure. These are exactly the
 * post-funding statuses: the customer has already paid, so the run owes them a verdict and may not
 * simply stop existing. Pre-funding statuses are absent on purpose -- an unpaid run that fails has
 * nothing to attest, and belongs in CANCELLED/EXPIRED, which is the payment side's concern.
 */
const FINALIZABLE_STATUSES = new Set<RunStatus>([
  'FUNDED',
  'ANALYZING',
  'PLAN_COMPILED',
  'PROCURING',
  'EXECUTING',
  'REPLANNING',
  'EVIDENCE_BUILDING',
  'ATTESTING',
]);

/**
 * Drives a funded run that can no longer make progress to DELIVERED_INCONCLUSIVE, with an evidence
 * pack that records why and an on-chain attestation carrying the INCONCLUSIVE result.
 *
 * Without this, a run whose job dead-letters keeps whatever status it failed at forever: the
 * customer paid, the dashboard shows PROCURING, and nothing ever resolves it. `docs/state-machine.md`
 * is explicit that after FUNDED "cancellation or silent expiry is not allowed. Failures are
 * documented through evidence and delivered as FAIL or INCONCLUSIVE" -- this is the code that
 * makes that true.
 *
 * Returns null, without touching anything, when the run is already terminal, was never funded, or
 * is otherwise not ours to finalize. It is safe to call more than once: every step is guarded by
 * the run's own persisted status and the existing checkpoint, exactly like the main pipeline's
 * resume path, so a second call after a partial failure continues rather than duplicating.
 */
export async function finalizeRunAsInconclusive(
  runId: string,
  deps: OrchestratorPipelineDependencies,
  reason: string,
): Promise<PipelineResult | null> {
  const now = deps.now ?? (() => new Date());
  const record = await deps.runRepository.findById(runId);
  if (!record || !FINALIZABLE_STATUSES.has(record.aggregate.status)) return null;
  // No recorded customer payment means this run was never really funded; there is nothing to
  // attest and forcing a verdict would invent one.
  if (!record.customerPaymentProofHash || !record.customerPaymentAtomic) return null;
  const quote = await deps.quoteRepository.findById(record.quoteId);
  if (!quote) return null;

  const { quoteId, requestIdempotencyKey } = record;
  const targetVersionHash = quote.request.targetVersionHash as `0x${string}`;
  const policyHash = quote.request.policyHash as `0x${string}`;
  let current = record.aggregate;

  async function advance(actor: RunActor, to: RunStatus): Promise<void> {
    if (STATUS_ORDER.indexOf(current.status) >= STATUS_ORDER.indexOf(to)) return;
    const result = transitionRun(current, {
      actor,
      expectedRevision: current.revision,
      idempotencyKey: `orchestrator:${runId}:${to}`,
      occurredAt: now().toISOString(),
      to,
    });
    current = result.run;
    if (!result.event) return;
    await deps.runRepository.save(
      { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
      result.run.revision - 1,
    );
  }

  const checkpoint = await deps.checkpointStore.load(runId);
  // Only the scenarios that actually got a response back can be receipted. A run finalized
  // mid-execution may hold half-written ones, and letting a single unreceiptable scenario throw
  // here would put the run right back where this function exists to rescue it from.
  const scenarioResults = ((checkpoint.evidence as readonly ScenarioResult[] | undefined) ?? []).filter((result) =>
    canBuildToolReceipt(result.evidence),
  );
  // Fall back to the run's own timestamps, never to wall-clock "now": the registry rejects a
  // completedAt above the chain's block.timestamp, and a maintenance run finalizing an old run
  // would otherwise stamp it with a time the chain has not reached yet. The run's persisted times
  // are also the truthful answer -- it stopped when it stopped, not when someone cleaned up.
  const startedAtSeconds = checkpoint.startedAt ?? Math.floor(Date.parse(record.aggregate.createdAt) / 1_000);
  const completedAtSeconds = checkpoint.completedAt ?? Math.floor(Date.parse(record.aggregate.updatedAt) / 1_000);
  // A run that never reached risk analysis has no plan to report. Rather than omit the section,
  // stand in a plan that says exactly that, so the pack still explains itself.
  const plan: CompiledTestPlan = (checkpoint.plan as CompiledTestPlan | undefined) ?? {
    scenarios: [],
    toolBudgetAtomic: '0',
    riskLevel: 'HIGH',
    rationale: `Run finalized as INCONCLUSIVE before a test plan was compiled: ${reason}`,
  };

  // FUNDED's only legal successor is ANALYZING, so step through it rather than jumping.
  if (current.status === 'FUNDED') await advance('ORCHESTRATOR', 'ANALYZING');
  await advance('SYSTEM', 'EVIDENCE_BUILDING');

  const { evidencePack, evidenceURI } = await runEvidencePhase(
    deps,
    runId,
    quote,
    targetVersionHash,
    policyHash,
    plan,
    checkpoint.proposal as RiskClassification | undefined,
    scenarioResults,
    startedAtSeconds,
    completedAtSeconds,
    now,
    'INCONCLUSIVE',
  );

  await advance('EVIDENCE_WORKER', 'ATTESTING');
  const { attestationTransactionHash } = await runAttestationPhase(
    deps,
    runId,
    checkpoint,
    quote,
    targetVersionHash,
    policyHash,
    record.customerPaymentProofHash,
    record.customerPaymentAtomic,
    evidencePack,
    evidenceURI,
    BigInt(checkpoint.targetPaymentAmountAtomic ?? '0'),
    completedAtSeconds,
    'INCONCLUSIVE',
    now,
  );

  if (current.status !== 'DELIVERED_INCONCLUSIVE') {
    const result = transitionRun(current, {
      actor: 'ATTESTOR',
      expectedRevision: current.revision,
      idempotencyKey: `orchestrator:${runId}:DELIVERED_INCONCLUSIVE`,
      occurredAt: now().toISOString(),
      to: 'DELIVERED_INCONCLUSIVE',
    });
    current = result.run;
    if (result.event) {
      await deps.runRepository.save(
        { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
        result.run.revision - 1,
      );
    }
  }

  return { runId, finalStatus: 'DELIVERED_INCONCLUSIVE', attestationTransactionHash };
}
