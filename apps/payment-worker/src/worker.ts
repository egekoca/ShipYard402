import {
  PaymentNotReadyError,
  SettlementRejectedError,
  type PaymentReconciler,
} from '@shipyard402/payment-reconciliation';

export type PaymentReconciliationJob = Readonly<{
  runId: string;
  attempt: number;
  maximumAttempts: number;
}>;

export type PaymentJobResult =
  | Readonly<{ action: 'ACK'; proofHash: `0x${string}`; transactionHash: `0x${string}` }>
  | Readonly<{ action: 'RETRY'; delayMilliseconds: number; reason: string }>
  | Readonly<{ action: 'DEAD_LETTER'; reason: string; failureCodes?: readonly string[] }>;

export class PaymentReconciliationJobHandler {
  readonly #reconciler: PaymentReconciler;

  constructor(reconciler: PaymentReconciler) {
    this.#reconciler = reconciler;
  }

  async handle(job: PaymentReconciliationJob, signal?: AbortSignal): Promise<PaymentJobResult> {
    validateJob(job);
    try {
      const payment = await this.#reconciler.reconcile(job.runId, signal);
      return {
        action: 'ACK',
        proofHash: payment.proofHash,
        transactionHash: payment.proof.transactionHash,
      };
    } catch (error) {
      if (error instanceof SettlementRejectedError) {
        return { action: 'DEAD_LETTER', reason: 'DETERMINISTIC_SETTLEMENT_REJECTION', failureCodes: error.failureCodes };
      }
      if (job.attempt >= job.maximumAttempts) {
        return { action: 'DEAD_LETTER', reason: classifyRetryableError(error) };
      }
      return {
        action: 'RETRY',
        delayMilliseconds: retryDelay(job.attempt),
        reason: error instanceof PaymentNotReadyError ? 'PAYMENT_NOT_READY' : classifyRetryableError(error),
      };
    }
  }
}

function validateJob(job: PaymentReconciliationJob): void {
  if (!job.runId || !Number.isInteger(job.attempt) || !Number.isInteger(job.maximumAttempts)) {
    throw new Error('Invalid payment reconciliation job');
  }
  if (job.attempt < 1 || job.maximumAttempts < 1 || job.attempt > job.maximumAttempts) {
    throw new Error('Invalid payment reconciliation attempt bounds');
  }
}

function retryDelay(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 60_000);
}

function classifyRetryableError(error: unknown): string {
  if (error instanceof Error && /timeout|temporar|rate|RPC/i.test(error.message)) return 'TRANSIENT_DEPENDENCY_FAILURE';
  return 'UNCLASSIFIED_RECONCILIATION_FAILURE';
}
