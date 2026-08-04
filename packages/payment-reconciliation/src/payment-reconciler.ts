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

export interface PaymentReconciliationStore {
  loadFundableRun(runId: string): Promise<FundableRun | null>;
  commitFundedRun(input: Readonly<{
    previousRevision: number;
    run: RunAggregate;
    event: RunTransitionedEvent;
    payment: VerifiedCustomerPayment;
  }>): Promise<void>;
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

  constructor(options: Readonly<{
    merchantAdapter: X402MerchantAdapter;
    receiptReader: ChainReceiptReader;
    store: PaymentReconciliationStore;
    now?: () => Date;
  }>) {
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
      throw new PaymentNotReadyError(order.status);
    }
    const proof = await this.#merchantAdapter.getOrderProof(order.orderId, signal);
    const receipt = await this.#receiptReader.getTransactionReceipt(order.chainId, proof.transactionHash, signal);
    if (!receipt) throw new SettlementRejectedError(['TRANSACTION_RECEIPT_MISSING']);

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
}
