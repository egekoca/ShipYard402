import {
  BridgeDeliveryPendingError,
  finalizeRunAsInconclusive,
  CrossChainSettlementAmbiguousError,
  PaymentSendAmbiguousError,
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
  runOrchestratorPipeline,
  type OrchestratorPipelineDependencies,
  type PipelineResult,
} from './pipeline.js';

export type OrchestratorPipelineRunner = (
  runId: string,
  deps: OrchestratorPipelineDependencies,
) => Promise<PipelineResult>;

/** Drives a funded run that can no longer progress to a terminal INCONCLUSIVE delivery. */
export type OrchestratorRunFinalizer = (
  runId: string,
  deps: OrchestratorPipelineDependencies,
  reason: string,
) => Promise<PipelineResult | null>;

export type OrchestratorJob = Readonly<{
  runId: string;
  attempt: number;
  maximumAttempts: number;
}>;

export type OrchestratorJobResult =
  | Readonly<{ action: 'ACK'; finalStatus: string; attestationTransactionHash: `0x${string}` }>
  | Readonly<{ action: 'RETRY'; delayMilliseconds: number; reason: string }>
  | Readonly<{ action: 'WAIT'; delayMilliseconds: number; reason: string }>
  | Readonly<{ action: 'DEAD_LETTER'; reason: string; failureCodes?: readonly string[] }>;

export type LeasedOrchestratorJob = OrchestratorJob & Readonly<{ leaseOwner: string }>;

export interface OrchestratorJobQueue {
  claimNext(input: Readonly<{ workerId: string; leaseDurationSeconds: number }>): Promise<LeasedOrchestratorJob | null>;
  markCompleted(job: LeasedOrchestratorJob): Promise<void>;
  markRetry(job: LeasedOrchestratorJob, delayMilliseconds: number, reason: string): Promise<void>;
  markWaiting?(job: LeasedOrchestratorJob, delayMilliseconds: number, reason: string): Promise<void>;
  markDeadLetter(job: LeasedOrchestratorJob, reason: string, failureCodes?: readonly string[]): Promise<void>;
}

export class OrchestratorJobHandler {
  readonly #deps: OrchestratorPipelineDependencies;
  readonly #runPipeline: OrchestratorPipelineRunner;
  readonly #finalizeRun: OrchestratorRunFinalizer;

  constructor(
    deps: OrchestratorPipelineDependencies,
    runPipeline: OrchestratorPipelineRunner = runOrchestratorPipeline,
    finalizeRun: OrchestratorRunFinalizer = finalizeRunAsInconclusive,
  ) {
    this.#deps = deps;
    this.#runPipeline = runPipeline;
    this.#finalizeRun = finalizeRun;
  }

  /**
   * Dead-letters a job, first driving its run to a terminal INCONCLUSIVE delivery so a paying
   * customer is never left with a run that stopped at whatever status it failed at. Finalization
   * is best-effort on purpose: if it throws, the job is still dead-lettered rather than being
   * retried forever, and the run stays visible for a later manual pass.
   */
  async #deadLetter(runId: string, reason: string, failureCodes?: readonly string[]): Promise<OrchestratorJobResult> {
    try {
      const finalized = await this.#finalizeRun(runId, this.#deps, reason);
      if (finalized) {
        console.warn(`[orchestrator-worker] finalized ${runId} as DELIVERED_INCONCLUSIVE after ${reason}`);
      }
    } catch (error) {
      console.error(`[orchestrator-worker] could not finalize ${runId} as INCONCLUSIVE after ${reason}:`, error);
    }
    return { action: 'DEAD_LETTER', reason, ...(failureCodes ? { failureCodes } : {}) };
  }

  async handle(job: OrchestratorJob): Promise<OrchestratorJobResult> {
    validateJob(job);
    try {
      const result = await this.#runPipeline(job.runId, this.#deps);
      return {
        action: 'ACK',
        finalStatus: result.finalStatus,
        attestationTransactionHash: result.attestationTransactionHash,
      };
    } catch (error) {
      console.error(
        `[orchestrator-worker] pipeline failure for ${job.runId} (attempt ${job.attempt}/${job.maximumAttempts}):`,
        error,
      );
      if (error instanceof RunNotReadyForOrchestrationError) {
        return { action: 'DEAD_LETTER', reason: 'UNEXPECTED_RUN_STATE' };
      }
      if (error instanceof ProcurementDeniedError) {
        return await this.#deadLetter(job.runId, 'PROCUREMENT_DENIED', error.denialCodes);
      }
      // Never auto-retry an ambiguous send: retrying is exactly the double-payment risk this
      // error exists to prevent. This needs a human to check the chain before the run continues.
      // Deliberately NOT finalized: the attestation registry is append-only, so writing an
      // INCONCLUSIVE verdict here would commit an unretractable claim about a run whose money
      // state nobody has established yet. These wait for a human to check the chain first.
      if (error instanceof PaymentSendAmbiguousError) {
        return { action: 'DEAD_LETTER', reason: 'PAYMENT_SEND_AMBIGUOUS_NEEDS_MANUAL_RECONCILIATION' };
      }
      if (error instanceof CrossChainSettlementAmbiguousError) {
        return { action: 'DEAD_LETTER', reason: 'BNB_SETTLEMENT_AMBIGUOUS_NEEDS_MANUAL_RECONCILIATION' };
      }
      if (error instanceof BridgeDeliveryPendingError) {
        return { action: 'WAIT', delayMilliseconds: 15_000, reason: 'BRIDGE_DELIVERY_PENDING' };
      }
      // A mid-pipeline failure (OrchestratorPipelineError with advancedPastFunded=true) is safe
      // to retry: the pipeline is checkpoint-resumable, so a re-claimed job picks up from the
      // run's persisted status and artifacts instead of repeating spend-once side effects.
      if (job.attempt >= job.maximumAttempts) {
        return await this.#deadLetter(job.runId, 'PIPELINE_RETRIES_EXHAUSTED');
      }
      return { action: 'RETRY', delayMilliseconds: retryDelay(job.attempt), reason: classifyRetryableError(error) };
    }
  }
}

export async function processNextOrchestratorJob(
  queue: OrchestratorJobQueue,
  handler: OrchestratorJobHandler,
  claim: Readonly<{ workerId: string; leaseDurationSeconds: number }>,
): Promise<boolean> {
  const job = await queue.claimNext(claim);
  if (!job) return false;
  const result = await handler.handle(job);
  switch (result.action) {
    case 'ACK':
      await queue.markCompleted(job);
      return true;
    case 'RETRY':
      await queue.markRetry(job, result.delayMilliseconds, result.reason);
      return true;
    case 'WAIT':
      if (queue.markWaiting) await queue.markWaiting(job, result.delayMilliseconds, result.reason);
      else await queue.markRetry(job, result.delayMilliseconds, result.reason);
      return true;
    case 'DEAD_LETTER':
      await queue.markDeadLetter(job, result.reason, result.failureCodes ?? []);
      return true;
  }
}

function validateJob(job: OrchestratorJob): void {
  if (!job.runId || !Number.isInteger(job.attempt) || !Number.isInteger(job.maximumAttempts)) {
    throw new Error('Invalid orchestrator job');
  }
  if (job.attempt < 1 || job.maximumAttempts < 1 || job.attempt > job.maximumAttempts) {
    throw new Error('Invalid orchestrator attempt bounds');
  }
}

function retryDelay(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 60_000);
}

function classifyRetryableError(error: unknown): string {
  const pattern = /timeout|temporar|rate|RPC|fetch/i;
  if (error instanceof Error && pattern.test(error.message)) return 'TRANSIENT_DEPENDENCY_FAILURE';
  if (error instanceof Error && error.cause instanceof Error && pattern.test(error.cause.message))
    return 'TRANSIENT_DEPENDENCY_FAILURE';
  return 'UNCLASSIFIED_ORCHESTRATION_FAILURE';
}
