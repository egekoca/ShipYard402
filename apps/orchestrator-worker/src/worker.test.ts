import { describe, expect, it } from 'vitest';

import { PaymentSendAmbiguousError, ProcurementDeniedError, RunNotReadyForOrchestrationError, OrchestratorPipelineError } from './pipeline.js';
import { OrchestratorJobHandler, processNextOrchestratorJob, type LeasedOrchestratorJob, type OrchestratorJobQueue } from './worker.js';

function handlerThatThrows(error: unknown): OrchestratorJobHandler {
  return new OrchestratorJobHandler({} as never, async () => {
    throw error;
  });
}

describe('orchestrator job handler', () => {
  it('dead-letters a run that is not FUNDED', async () => {
    const handler = handlerThatThrows(new RunNotReadyForOrchestrationError('PLAN_COMPILED'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER', reason: 'UNEXPECTED_RUN_STATE',
    });
  });

  it('dead-letters a denied procurement with denial codes surfaced', async () => {
    const handler = handlerThatThrows(new ProcurementDeniedError(['HOST_NOT_ALLOWED']));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER', reason: 'PROCUREMENT_DENIED', failureCodes: ['HOST_NOT_ALLOWED'],
    });
  });

  it('dead-letters an ambiguous payment send instead of ever retrying it, since a retry is the double-payment risk itself', async () => {
    const handler = handlerThatThrows(new PaymentSendAmbiguousError('run-1', 3, 'payment'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER', reason: 'PAYMENT_SEND_AMBIGUOUS_NEEDS_MANUAL_RECONCILIATION',
    });
  });

  it('retries a mid-pipeline failure instead of dead-lettering, since the pipeline is checkpoint-resumable', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'RETRY', delayMilliseconds: 5_000, reason: 'UNCLASSIFIED_ORCHESTRATION_FAILURE',
    });
  });

  it('eventually dead-letters a mid-pipeline failure once retries are exhausted', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true));
    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER', reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
  });

  it('retries a transient failure that occurred before any state mutation', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', false, { cause: new Error('fetch timeout') }));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'RETRY', delayMilliseconds: 5_000, reason: 'TRANSIENT_DEPENDENCY_FAILURE',
    });
  });

  it('dead-letters once retries are exhausted', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', false));
    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER', reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
  });

  it('persists the handler outcome through the queue lease before acknowledging work', async () => {
    const job = { runId: 'run-1', attempt: 1, maximumAttempts: 5, leaseOwner: 'worker:test' } satisfies LeasedOrchestratorJob;
    const actions: string[] = [];
    let claimed = false;
    const queue: OrchestratorJobQueue = {
      async claimNext() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async markCompleted() { actions.push('completed'); },
      async markRetry(_job, delay, reason) { actions.push(`retry:${delay}:${reason}`); },
      async markDeadLetter(_job, reason) { actions.push(`dead-letter:${reason}`); },
    };
    const handler = handlerThatThrows(new ProcurementDeniedError(['HOST_NOT_ALLOWED']));

    await expect(processNextOrchestratorJob(queue, handler, { workerId: 'worker:test', leaseDurationSeconds: 30 }))
      .resolves.toBe(true);
    expect(actions).toEqual(['dead-letter:PROCUREMENT_DENIED']);
    await expect(processNextOrchestratorJob(queue, handler, { workerId: 'worker:test', leaseDurationSeconds: 30 }))
      .resolves.toBe(false);
  });
});
