import {
  PaymentNotReadyError,
  SettlementRejectedError,
  type PaymentReconciler,
} from '@shipyard402/payment-reconciliation';
import { describe, expect, it } from 'vitest';

import {
  PaymentReconciliationJobHandler,
  processNextPaymentJob,
  type LeasedPaymentReconciliationJob,
  type PaymentReconciliationJobQueue,
} from './worker.js';

function reconciler(implementation: () => Promise<unknown>): PaymentReconciler {
  return { reconcile: implementation } as unknown as PaymentReconciler;
}

describe('payment reconciliation job handler', () => {
  it('retries an unconfirmed payment with bounded exponential delay', async () => {
    const handler = new PaymentReconciliationJobHandler(reconciler(async () => {
      throw new PaymentNotReadyError('CHECKOUT_VERIFIED');
    }));
    await expect(handler.handle({ runId: 'run-1', attempt: 2, maximumAttempts: 5 })).resolves.toEqual({
      action: 'RETRY', delayMilliseconds: 10_000, reason: 'PAYMENT_NOT_READY',
    });
  });

  it('dead-letters deterministic settlement mismatches without retrying', async () => {
    const handler = new PaymentReconciliationJobHandler(reconciler(async () => {
      throw new SettlementRejectedError(['RECIPIENT_MISMATCH']);
    }));
    await expect(handler.handle({ runId: 'run-1', attempt: 1, maximumAttempts: 5 })).resolves.toEqual({
      action: 'DEAD_LETTER',
      reason: 'DETERMINISTIC_SETTLEMENT_REJECTION',
      failureCodes: ['RECIPIENT_MISMATCH'],
    });
  });

  it('persists the handler outcome through the queue lease before acknowledging work', async () => {
    const job = {
      runId: 'run-1', attempt: 1, maximumAttempts: 5, leaseOwner: 'worker:test',
    } satisfies LeasedPaymentReconciliationJob;
    const actions: string[] = [];
    let claimed = false;
    const queue: PaymentReconciliationJobQueue = {
      async claimNext() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async markCompleted() { actions.push('completed'); },
      async markRetry(_job, delay, reason) { actions.push(`retry:${delay}:${reason}`); },
      async markDeadLetter() { actions.push('dead-letter'); },
    };
    const handler = new PaymentReconciliationJobHandler(reconciler(async () => {
      throw new PaymentNotReadyError('CHECKOUT_VERIFIED');
    }));

    await expect(processNextPaymentJob(queue, handler, {
      workerId: 'worker:test', leaseDurationSeconds: 30,
    })).resolves.toBe(true);
    expect(actions).toEqual(['retry:5000:PAYMENT_NOT_READY']);
    await expect(processNextPaymentJob(queue, handler, {
      workerId: 'worker:test', leaseDurationSeconds: 30,
    })).resolves.toBe(false);
  });
});
