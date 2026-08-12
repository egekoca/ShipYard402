import type { Quote } from '@shipyard402/quote-engine';
import { transitionRun, type RunAggregate, type RunTransitionedEvent } from '@shipyard402/run-domain';
import {
  verifySettlement,
  type MerchantOrder,
  type MerchantPaymentProof,
  type NormalizedTransactionReceipt,
  type X402MerchantAdapter,
} from '@shipyard402/x402-payments';
import { keccak256, toUtf8Bytes } from 'ethers';

export type FundableRun = Readonly<{
  run: RunAggregate;
  quote: Quote;
  paymentOrder: MerchantOrder;
  customerPaymentProofHash?: `0x${string}`;
  customerPayment?: VerifiedCustomerPayment;
}>;

export type VerifiedCustomerPayment = Readonly<{
  runId: string;
  order: MerchantOrder;
  proof: MerchantPaymentProof;
  receipt: NormalizedTransactionReceipt;
  proofHash: `0x${string}`;
  verifiedAt: string;
}>;

/** A pre-funding run whose payment window has closed, and which deadline closed it. */
export type ExpirableRun = Readonly<{
  run: RunAggregate;
  deadline: string;
  reason: 'QUOTE_EXPIRED' | 'ORDER_EXPIRED';
}>;

export interface PaymentReconciliationStore {
  loadFundableRun(runId: string): Promise<FundableRun | null>;
  /**
   * Runs still awaiting payment whose deadline has passed -- the merchant order's when one exists,
   * otherwise the quote's. A run abandoned at QUOTED never reaches the reconciliation queue at all,
   * so a sweep is the only thing that can ever close it out.
   */
  findRunsPastPaymentDeadline(now: Date, limit: number): Promise<readonly ExpirableRun[]>;
  /**
   * Persists a PAYMENT_REQUIRED -> EXPIRED transition for an order whose deadline passed without
   * funding. Separate from commitFundedRun because nothing is received here: no receipt row, no
   * payment amount, and no orchestrator job to enqueue.
   */
  commitExpiredRun(
    input: Readonly<{ previousRevision: number; run: RunAggregate; event: RunTransitionedEvent }>,
  ): Promise<void>;
  commitFundedRun(
    input: Readonly<{
      previousRevision: number;
      run: RunAggregate;
      event: RunTransitionedEvent;
      payment: VerifiedCustomerPayment;
    }>,
  ): Promise<void>;
}

export interface ChainReceiptReader {
  getTransactionReceipt(
    chainId: number,
    transactionHash: `0x${string}`,
    signal?: AbortSignal,
  ): Promise<NormalizedTransactionReceipt | null>;
}

export class PaymentNotReadyError extends Error {
  constructor(status: string) {
    super(`Customer payment is not in a terminal-success state: ${status}`);
    this.name = 'PaymentNotReadyError';
  }
}

export class ReceiptNotYetAvailableError extends Error {
  constructor(transactionHash: string) {
    super(`Transaction receipt not yet available from the chain reader: ${transactionHash}`);
    this.name = 'ReceiptNotYetAvailableError';
  }
}

/**
 * The merchant order's own deadline passed while it was still unpaid, so no amount of further
 * polling can change the outcome. Distinct from PaymentNotReadyError, which means "not yet".
 */
export class PaymentOrderExpiredError extends Error {
  readonly orderId: string;
  readonly expiresAt: string;

  constructor(orderId: string, expiresAt: string) {
    super(`Customer payment order ${orderId} expired unpaid at ${expiresAt}`);
    this.name = 'PaymentOrderExpiredError';
    this.orderId = orderId;
    this.expiresAt = expiresAt;
  }
}

export class SettlementRejectedError extends Error {
  readonly failureCodes: readonly string[];

  constructor(failureCodes: readonly string[]) {
    super(`Customer settlement rejected: ${failureCodes.join(', ')}`);
    this.name = 'SettlementRejectedError';
    this.failureCodes = failureCodes;
  }
}

export class PaymentReconciler {
  readonly #merchantAdapter: X402MerchantAdapter;
  readonly #receiptReader: ChainReceiptReader;
  readonly #store: PaymentReconciliationStore;
  readonly #now: () => Date;

  constructor(
    options: Readonly<{
      merchantAdapter: X402MerchantAdapter;
      receiptReader: ChainReceiptReader;
      store: PaymentReconciliationStore;
      now?: () => Date;
    }>,
  ) {
    this.#merchantAdapter = options.merchantAdapter;
    this.#receiptReader = options.receiptReader;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  async reconcile(runId: string, signal?: AbortSignal): Promise<VerifiedCustomerPayment> {
    const context = await this.#store.loadFundableRun(runId);
    if (!context) throw new Error(`Fundable run not found: ${runId}`);
    if (context.run.status === 'FUNDED' && context.customerPaymentProofHash) {
      if (context.customerPayment?.proofHash.toLowerCase() === context.customerPaymentProofHash.toLowerCase()) {
        return context.customerPayment;
      }
      throw new Error('Funded run is missing its immutable verified customer payment');
    }
    if (context.run.status !== 'PAYMENT_REQUIRED') {
      throw new Error(`Run ${runId} is not awaiting payment`);
    }

    const order = await this.#merchantAdapter.getOrderStatus(context.paymentOrder.orderId, signal);
    if (order.status !== 'PAYMENT_CONFIRMED' && order.status !== 'INVOICED') {
      // An order that outlived its own deadline is a settled question, not a slow one. Reporting
      // it as "not ready" would keep the run polling until its retry budget ran out and then leave
      // it in PAYMENT_REQUIRED forever, which is how unpaid runs used to get stranded.
      if (this.#now().getTime() >= Date.parse(order.expiresAt)) {
        throw new PaymentOrderExpiredError(order.orderId, order.expiresAt);
      }
      throw new PaymentNotReadyError(order.status);
    }
    const proof = await this.#merchantAdapter.getOrderProof(order.orderId, signal);
    const receipt = await this.#receiptReader.getTransactionReceipt(order.chainId, proof.transactionHash, signal);
    // A null receipt means the chain reader's RPC hasn't indexed it yet, not that the payment was
    // rejected -- this is transient and must be retried, never dead-lettered like a genuine
    // verifySettlement mismatch below.
    if (!receipt) throw new ReceiptNotYetAvailableError(proof.transactionHash);

    const verification = verifySettlement(order, proof, receipt, {
      chainId: context.quote.capabilitySnapshot.chainId,
      tokenAddress: context.quote.capabilitySnapshot.tokenAddress as `0x${string}`,
      payerAddress: context.quote.request.requesterAddress as `0x${string}`,
      recipientAddress: context.quote.capabilitySnapshot.receivingAddress as `0x${string}`,
      atomicAmount: context.quote.totalAtomicAmount,
      orderId: context.paymentOrder.orderId,
    });
    if (!verification.valid) throw new SettlementRejectedError(verification.failureCodes);

    const verifiedAt = this.#now().toISOString();
    const transitioned = transitionRun(context.run, {
      actor: 'PAYMENT_RECONCILER',
      expectedRevision: context.run.revision,
      idempotencyKey: `customer-payment:${proof.transactionHash.toLowerCase()}:${proof.logIndex}`,
      occurredAt: verifiedAt,
      to: 'FUNDED',
    });
    if (!transitioned.event) throw new Error('Payment reconciliation transition produced no event');

    const payment: VerifiedCustomerPayment = {
      runId,
      order,
      proof,
      receipt,
      proofHash: keccak256(toUtf8Bytes(verification.paymentProofHashMaterial)) as `0x${string}`,
      verifiedAt,
    };
    await this.#store.commitFundedRun({
      previousRevision: context.run.revision,
      run: transitioned.run,
      event: transitioned.event,
      payment,
    });
    return payment;
  }

  /**
   * Moves a run whose payment order expired unpaid to the terminal EXPIRED state. Idempotent and
   * safe to call on a run that has since been funded or already expired: it only acts while the
   * run is still PAYMENT_REQUIRED, and reports whether it did anything.
   */
  async expireRun(runId: string): Promise<boolean> {
    const context = await this.#store.loadFundableRun(runId);
    if (context?.run.status !== 'PAYMENT_REQUIRED') return false;
    return this.#expire(context.run, `payment-order-expired:${context.paymentOrder.orderId}`);
  }

  /**
   * Closes out every run whose payment window has passed. Runs abandoned at QUOTED never get a
   * reconciliation job, so without this sweep they accumulate in a non-terminal state forever.
   * Returns the run IDs it actually expired; a run funded since the query is skipped, not forced.
   */
  async sweepExpiredRuns(limit = 100): Promise<readonly string[]> {
    const candidates = await this.#store.findRunsPastPaymentDeadline(this.#now(), limit);
    const expired: string[] = [];
    for (const candidate of candidates) {
      if (await this.#expire(candidate.run, `payment-deadline-passed:${candidate.deadline}`)) {
        expired.push(candidate.run.id);
      }
    }
    return expired;
  }

  async #expire(run: RunAggregate, idempotencyKey: string): Promise<boolean> {
    // Timestamps never move backwards in a run's event log, so a deadline that passed before the
    // run's own last event still records at that event's time rather than being rejected.
    const occurredAt = new Date(Math.max(this.#now().getTime(), Date.parse(run.updatedAt) + 1_000)).toISOString();
    const transitioned = transitionRun(run, {
      actor: 'SYSTEM',
      expectedRevision: run.revision,
      idempotencyKey,
      occurredAt,
      to: 'EXPIRED',
    });
    if (!transitioned.event) return false;

    await this.#store.commitExpiredRun({
      previousRevision: run.revision,
      run: transitioned.run,
      event: transitioned.event,
    });
    return true;
  }
}
