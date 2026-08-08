import { transitionRun, type RunActor, type RunStatus } from '@shipyard402/run-domain';

import { runAttestationPhase } from './pipeline/attestation-phase.js';
import {
  OrchestratorPipelineError,
  PaymentSendAmbiguousError,
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
} from './pipeline/errors.js';
import { runEvidencePhase } from './pipeline/evidence-phase.js';
import { runExecutionPhase } from './pipeline/execution-phase.js';
import { runProcurementPhase } from './pipeline/procurement-phase.js';
import { runRiskAnalysisPhase } from './pipeline/risk-analysis-phase.js';
import type { OrchestratorPipelineDependencies, PipelineResult } from './pipeline/types.js';

// Re-exported so every existing `from './pipeline.js'` import elsewhere in this app (worker.ts,
// main.ts, the test suites) keeps working unchanged -- the split below is an internal
// reorganization, not a change to this module's public surface.
export {
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
    const { purchaseAmount, paymentTransactionHash, purchaseReceipt } = await runProcurementPhase(
      deps,
      runId,
      checkpoint,
      plan,
      quote,
      current.status,
      now,
    );

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
    if (error instanceof ProcurementDeniedError || error instanceof PaymentSendAmbiguousError) throw error;
    throw new OrchestratorPipelineError(`Orchestrator pipeline failed for run ${runId}`, advancedPastFunded, {
      cause: error,
    });
  }
}
