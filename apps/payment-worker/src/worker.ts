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

export type LeasedPaymentReconciliationJob = PaymentReconciliationJob & Readonly<{
  leaseOwner: string;
}>;

export interface PaymentReconciliationJobQueue {
  claimNext(input: Readonly<{
    workerId: string;
    leaseDurationSeconds: number;
  }>): Promise<LeasedPaymentReconciliationJob | null>;
  markCompleted(job: LeasedPaymentReconciliationJob): Promise<void>;
  markRetry(job: LeasedPaymentReconciliationJob, delayMilliseconds: number, reason: string): Promise<void>;
  markDeadLetter(
    job: LeasedPaymentReconciliationJob,
    reason: string,
    failureCodes?: readonly string[],
  ): Promise<void>;
}

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
      if (!(error instanceof PaymentNotReadyError)) {
        console.error(`[payment-worker] reconciliation failure for ${job.runId} (attempt ${job.attempt}/${job.maximumAttempts}):`, error);
      }
      if (job.attempt >= job.maximumAttempts) {
        const reason = error instanceof PaymentNotReadyError
          ? 'PAYMENT_NOT_READY_TIMEOUT'
          : classifyRetryableError(error);
        return { action: 'DEAD_LETTER', reason };
      }
      return {
        action: 'RETRY',
        delayMilliseconds: retryDelay(job.attempt),
        reason: error instanceof PaymentNotReadyError ? 'PAYMENT_NOT_READY' : classifyRetryableError(error),
      };
    }
  }
}

export async function processNextPaymentJob(
  queue: PaymentReconciliationJobQueue,
  handler: PaymentReconciliationJobHandler,
  claim: Readonly<{ workerId: string; leaseDurationSeconds: number }>,
  signal?: AbortSignal,
): Promise<boolean> {
  const job = await queue.claimNext(claim);
  if (!job) return false;
  const result = await handler.handle(job, signal);
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

function validateJob(job: PaymentReconciliationJob): void {
  if (!job.runId || !Number.isInteger(job.attempt) || !Number.isInteger(job.maximumAttempts)) {
    throw new Error('Invalid payment reconciliation job');
  }
  if (job.attempt < 1 || job.maximumAttempts < 1 || job.attempt > job.maximumAttempts) {
    throw new Error('Invalid payment reconciliation attempt bounds');
  }
}

function retryDelay(attempt: number): number {
  // Capped low on purpose: this only governs how long a single job sleeps between reconciliation
  // attempts, not how long the worker overall waits on a slow human payer (that's
  // maximumAttempts). A high cap here means a payment that actually lands on-chain during a long
  // sleep sits undetected until the sleep ends -- a real settlement can be confirmed within a
  // second of the worker checking, but a 180s cap meant it could take up to three extra minutes
  // just because the job happened to be asleep. 30s keeps that worst case small while still
  // backing off quickly from constant polling during the early, most-likely-still-pending attempts.
  return Math.min(5_000 * 2 ** (attempt - 1), 30_000);
}

function classifyRetryableError(error: unknown): string {
  if (error instanceof Error && /timeout|temporar|rate|RPC/i.test(error.message)) return 'TRANSIENT_DEPENDENCY_FAILURE';
  return 'UNCLASSIFIED_RECONCILIATION_FAILURE';
}
