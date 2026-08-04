import {
  PaymentNotReadyError,
  SettlementRejectedError,
  type PaymentReconciler,
} from '@shipyard402/payment-reconciliation';
import { describe, expect, it } from 'vitest';

import { PaymentReconciliationJobHandler } from './worker.js';

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
});
