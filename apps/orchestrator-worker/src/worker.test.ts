import { describe, expect, it, vi } from 'vitest';

import {
  BridgeDeliveryPendingError,
  CrossChainSettlementAmbiguousError,
  PaymentSendAmbiguousError,
  ProcurementDeniedError,
  RunNotReadyForOrchestrationError,
  OrchestratorPipelineError,
} from './pipeline.js';
import {
  OrchestratorJobHandler,
  processNextOrchestratorJob,
  type LeasedOrchestratorJob,
  type OrchestratorJobQueue,
  type OrchestratorRunFinalizer,
} from './worker.js';

/** Stands in for finalizeRunAsInconclusive so these tests never touch a real run or the chain. */
const noFinalization: OrchestratorRunFinalizer = async () => null;

function handlerThatThrows(error: unknown, finalizeRun: OrchestratorRunFinalizer = noFinalization) {
  return new OrchestratorJobHandler(
    {} as never,
    async () => {
      throw error;
    },
    finalizeRun,
  );
}

describe('orchestrator job handler', () => {
  it('dead-letters a run that is not FUNDED', async () => {
    const handler = handlerThatThrows(new RunNotReadyForOrchestrationError('PLAN_COMPILED'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'UNEXPECTED_RUN_STATE',
    });
  });

  it('dead-letters a denied procurement with denial codes surfaced', async () => {
    const handler = handlerThatThrows(new ProcurementDeniedError(['HOST_NOT_ALLOWED']));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PROCUREMENT_DENIED',
      failureCodes: ['HOST_NOT_ALLOWED'],
    });
  });

  it('dead-letters an ambiguous payment send instead of ever retrying it, since a retry is the double-payment risk itself', async () => {
    const handler = handlerThatThrows(new PaymentSendAmbiguousError('run-1', 3, 'payment'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PAYMENT_SEND_AMBIGUOUS_NEEDS_MANUAL_RECONCILIATION',
    });
  });

  it('finalizes a run as INCONCLUSIVE before dead-lettering it, so a paid run never stops at PROCURING forever', async () => {
    const finalize = vi.fn<OrchestratorRunFinalizer>(async (runId) => ({
      runId,
      finalStatus: 'DELIVERED_INCONCLUSIVE',
      attestationTransactionHash: `0x${'ab'.repeat(32)}`,
    }));
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true), finalize);

    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
    expect(finalize).toHaveBeenCalledWith('run-1', expect.anything(), 'PIPELINE_RETRIES_EXHAUSTED');
  });

  it('finalizes a denied procurement too, since the customer has already paid for that run', async () => {
    const finalize = vi.fn<OrchestratorRunFinalizer>(async () => null);
    const handler = handlerThatThrows(new ProcurementDeniedError(['HOST_NOT_ALLOWED']), finalize);

    await handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 });

    expect(finalize).toHaveBeenCalledWith('run-1', expect.anything(), 'PROCUREMENT_DENIED');
  });

  it('still dead-letters when finalization itself fails, rather than retrying forever', async () => {
    const finalize = vi.fn<OrchestratorRunFinalizer>(async () => {
      throw new Error('IPFS unreachable');
    });
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true), finalize);

    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
  });

  it('never auto-finalizes an ambiguous settlement: the registry is append-only and the money state is unknown', async () => {
    const finalize = vi.fn<OrchestratorRunFinalizer>(async () => null);

    await handlerThatThrows(new PaymentSendAmbiguousError('run-1', 3, 'payment'), finalize).handle({
      runId: 'run-1',
      attempt: 1,
      maximumAttempts: 5,
    });
    await handlerThatThrows(new CrossChainSettlementAmbiguousError('run-1'), finalize).handle({
      runId: 'run-1',
      attempt: 1,
      maximumAttempts: 5,
    });

    expect(finalize).not.toHaveBeenCalled();
  });

  it('waits for bridge delivery without consuming a retry attempt', async () => {
    const handler = handlerThatThrows(new BridgeDeliveryPendingError('run-1'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'WAIT',
      delayMilliseconds: 15_000,
      reason: 'BRIDGE_DELIVERY_PENDING',
    });
  });

  it('dead-letters an ambiguous BNB settlement for manual reconciliation', async () => {
    const handler = handlerThatThrows(new CrossChainSettlementAmbiguousError('run-1'));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'BNB_SETTLEMENT_AMBIGUOUS_NEEDS_MANUAL_RECONCILIATION',
    });
  });

  it('retries a mid-pipeline failure instead of dead-lettering, since the pipeline is checkpoint-resumable', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'RETRY',
      delayMilliseconds: 5_000,
      reason: 'UNCLASSIFIED_ORCHESTRATION_FAILURE',
    });
  });

  it('eventually dead-letters a mid-pipeline failure once retries are exhausted', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', true));
    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
  });

  it('retries a transient failure that occurred before any state mutation', async () => {
    const handler = handlerThatThrows(
      new OrchestratorPipelineError('boom', false, { cause: new Error('fetch timeout') }),
    );
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'RETRY',
      delayMilliseconds: 5_000,
      reason: 'TRANSIENT_DEPENDENCY_FAILURE',
    });
  });

  it('dead-letters once retries are exhausted', async () => {
    const handler = handlerThatThrows(new OrchestratorPipelineError('boom', false));
    await expect(handler.handle({ runId: 'run-1', attempt: 5, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'PIPELINE_RETRIES_EXHAUSTED',
    });
  });

  it('persists the handler outcome through the queue lease before acknowledging work', async () => {
    const job = {
      runId: 'run-1',
      attempt: 1,
      maximumAttempts: 5,
      leaseOwner: 'worker:test',
    } satisfies LeasedOrchestratorJob;
    const actions: string[] = [];
    let claimed = false;
    const queue: OrchestratorJobQueue = {
      async claimNext() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async markCompleted() {
        actions.push('completed');
      },
      async markRetry(_job, delay, reason) {
        actions.push(`retry:${delay}:${reason}`);
      },
      async markDeadLetter(_job, reason) {
        actions.push(`dead-letter:${reason}`);
      },
    };
    const handler = handlerThatThrows(new ProcurementDeniedError(['HOST_NOT_ALLOWED']));

    await expect(
      processNextOrchestratorJob(queue, handler, { workerId: 'worker:test', leaseDurationSeconds: 30 }),
    ).resolves.toBe(true);
    expect(actions).toEqual(['dead-letter:PROCUREMENT_DENIED']);
    await expect(
      processNextOrchestratorJob(queue, handler, { workerId: 'worker:test', leaseDurationSeconds: 30 }),
    ).resolves.toBe(false);
  });
});
