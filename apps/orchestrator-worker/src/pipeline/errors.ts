import type { RunStatus } from '@shipyard402/run-domain';

export class RunNotReadyForOrchestrationError extends Error {
  constructor(status: RunStatus) {
    super(`Run cannot be orchestrated from status: ${status}`);
    this.name = 'RunNotReadyForOrchestrationError';
  }
}

export class ProcurementDeniedError extends Error {
  readonly denialCodes: readonly string[];

  constructor(denialCodes: readonly string[]) {
    super(`Procurement purchase was denied: ${denialCodes.join(', ')}`);
    this.name = 'ProcurementDeniedError';
    this.denialCodes = denialCodes;
  }
}

/**
 * A reserved payment/refund nonce was already consumed on-chain, but no transaction hash was
 * checkpointed for it -- almost certainly because the process crashed between broadcasting and
 * checkpointing. Resending would either be rejected or, worse, silently succeed as a genuine
 * second payment, so this halts the run for manual reconciliation instead of guessing.
 */
export class PaymentSendAmbiguousError extends Error {
  constructor(runId: string, nonce: number, purpose: 'payment' | 'refund') {
    super(
      `Run ${runId}: ${purpose} nonce ${nonce} was already consumed on-chain but no transaction hash was checkpointed. Manual reconciliation required before retrying.`,
    );
    this.name = 'PaymentSendAmbiguousError';
  }
}

/**
 * Whether the run was mutated past FUNDED before failure. Kept for observability/logging — the
 * pipeline is checkpoint-resumable (see CheckpointStorePort), so the job handler no longer treats
 * this as a signal to skip retrying: a re-claimed job re-enters runOrchestratorPipeline, which
 * picks up from the run's persisted status and checkpointed artifacts instead of starting over.
 */
export class OrchestratorPipelineError extends Error {
  readonly advancedPastFunded: boolean;

  constructor(message: string, advancedPastFunded: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OrchestratorPipelineError';
    this.advancedPastFunded = advancedPastFunded;
  }
}
