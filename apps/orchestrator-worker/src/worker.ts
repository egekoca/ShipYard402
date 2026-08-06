import {
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
  runOrchestratorPipeline,
  type OrchestratorPipelineDependencies,
  type PipelineResult,
} from './pipeline.js';

export type OrchestratorPipelineRunner = (runId: string, deps: OrchestratorPipelineDependencies) => Promise<PipelineResult>;

export type OrchestratorJob = Readonly<{
  runId: string;
  attempt: number;
  maximumAttempts: number;
}>;

export type OrchestratorJobResult =
  | Readonly<{ action: 'ACK'; finalStatus: string; attestationTransactionHash: `0x${string}` }>
  | Readonly<{ action: 'RETRY'; delayMilliseconds: number; reason: string }>
  | Readonly<{ action: 'DEAD_LETTER'; reason: string; failureCodes?: readonly string[] }>;

export type LeasedOrchestratorJob = OrchestratorJob & Readonly<{ leaseOwner: string }>;

export interface OrchestratorJobQueue {
  claimNext(input: Readonly<{ workerId: string; leaseDurationSeconds: number }>): Promise<LeasedOrchestratorJob | null>;
  markCompleted(job: LeasedOrchestratorJob): Promise<void>;
  markRetry(job: LeasedOrchestratorJob, delayMilliseconds: number, reason: string): Promise<void>;
  markDeadLetter(job: LeasedOrchestratorJob, reason: string, failureCodes?: readonly string[]): Promise<void>;
}

export class OrchestratorJobHandler {
  readonly #deps: OrchestratorPipelineDependencies;
  readonly #runPipeline: OrchestratorPipelineRunner;

  constructor(deps: OrchestratorPipelineDependencies, runPipeline: OrchestratorPipelineRunner = runOrchestratorPipeline) {
    this.#deps = deps;
    this.#runPipeline = runPipeline;
  }

  async handle(job: OrchestratorJob): Promise<OrchestratorJobResult> {
    validateJob(job);
    try {
      const result = await this.#runPipeline(job.runId, this.#deps);
      return { action: 'ACK', finalStatus: result.finalStatus, attestationTransactionHash: result.attestationTransactionHash };
    } catch (error) {
      console.error(`[orchestrator-worker] pipeline failure for ${job.runId} (attempt ${job.attempt}/${job.maximumAttempts}):`, error);
      if (error instanceof RunNotReadyForOrchestrationError) {
        return { action: 'DEAD_LETTER', reason: 'UNEXPECTED_RUN_STATE' };
      }
      if (error instanceof ProcurementDeniedError) {
        return { action: 'DEAD_LETTER', reason: 'PROCUREMENT_DENIED', failureCodes: error.denialCodes };
      }
      // A mid-pipeline failure (OrchestratorPipelineError with advancedPastFunded=true) is safe
      // to retry: the pipeline is checkpoint-resumable, so a re-claimed job picks up from the
      // run's persisted status and artifacts instead of repeating spend-once side effects.
      if (job.attempt >= job.maximumAttempts) {
        return { action: 'DEAD_LETTER', reason: 'PIPELINE_RETRIES_EXHAUSTED' };
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
  if (error instanceof Error && error.cause instanceof Error && pattern.test(error.cause.message)) return 'TRANSIENT_DEPENDENCY_FAILURE';
  return 'UNCLASSIFIED_ORCHESTRATION_FAILURE';
}
