import { QuoteEngine, type Quote } from '@shipyard402/quote-engine';
import { createDraftRun, transitionRun, type RunAggregate } from '@shipyard402/run-domain';
import { encodeTransferLog, type MerchantOrder, type X402MerchantAdapter } from '@shipyard402/x402-payments';
import { describe, expect, it } from 'vitest';

import {
  PaymentNotReadyError,
  PaymentOrderExpiredError,
  PaymentReconciler,
  ReceiptNotYetAvailableError,
  SettlementRejectedError,
  type ExpirableRun,
  type FundableRun,
  type PaymentReconciliationStore,
  type VerifiedCustomerPayment,
} from './payment-reconciler.js';

const token = '0x1000000000000000000000000000000000000001' as const;
const payer = '0x2000000000000000000000000000000000000002' as const;
const recipient = '0x3000000000000000000000000000000000000003' as const;
const txHash = `0x${'ab'.repeat(32)}` as const;

const capability = {
  environment: 'mainnet',
  merchantId: 'shipyard',
  mode: 'ERC20_DIRECT',
  chainId: 2345,
  tokenAddress: token,
  tokenSymbol: 'RUNTIME_TOKEN',
  tokenDecimals: 6,
  receivingAddress: recipient,
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '100000000',
  discoveredAt: '2026-08-04T10:00:00.000Z',
  source: 'AUTHENTICATED_API',
} as const;

const quote: Quote = new QuoteEngine(
  {
    pricingStatus: 'HYPOTHESIS',
    feeRateBps: 1667,
    mandatoryToolBudgetAtomic: '100',
    dynamicToolBudgetAtomic: '100',
    modelInfrastructureReserveAtomic: '100',
    chainStorageReserveAtomic: '100',
    riskSupportReserveAtomic: '100',
    quoteTtlSeconds: 900,
  },
  () => 'fixed',
).createQuote(
  {
    organizationId: '7d575e3d-a625-4b71-a28b-86dc202d1d7f',
    requesterAddress: payer,
    targetAgentId: 'agent:external',
    targetServiceId: 'service:external',
    targetVersionHash: `0x${'11'.repeat(32)}`,
    policyHash: `0x${'22'.repeat(32)}`,
    x402Endpoint: 'https://target.example/paid',
    openApiUrl: 'https://target.example/openapi.json',
    maximumCustomerBudgetAtomic: '1000',
  },
  capability,
  new Date('2026-08-04T10:00:00.000Z'),
);

const paymentRequired = {
  x402Version: 2,
  resource: { url: 'https://shipyard.example/run' },
  accepts: [
    { scheme: 'exact', network: 'eip155:2345', amount: '600', asset: token, payTo: recipient, maxTimeoutSeconds: 900 },
  ],
} as const;

const initialOrder: MerchantOrder = {
  orderId: 'order-1',
  dappOrderId: 'run-1',
  status: 'CHECKOUT_VERIFIED',
  chainId: 2345,
  tokenAddress: token,
  atomicAmount: '600',
  payerAddress: payer,
  payToAddress: recipient,
  expiresAt: '2026-08-04T10:15:00.000Z',
  paymentRequired,
};

function awaitingPaymentRun(): RunAggregate {
  const draft = createDraftRun('run-1', '2026-08-04T10:00:00.000Z');
  const quoted = transitionRun(draft, {
    actor: 'QUOTE_ENGINE',
    expectedRevision: 0,
    idempotencyKey: 'quoted-0001',
    occurredAt: '2026-08-04T10:00:00.000Z',
    to: 'QUOTED',
  }).run;
  return transitionRun(quoted, {
    actor: 'MERCHANT_GATEWAY',
    expectedRevision: 1,
    idempotencyKey: 'payment-order-0001',
    occurredAt: '2026-08-04T10:00:01.000Z',
    to: 'PAYMENT_REQUIRED',
  }).run;
}

class MemoryStore implements PaymentReconciliationStore {
  context: FundableRun = { run: awaitingPaymentRun(), quote, paymentOrder: initialOrder };
  committed?: VerifiedCustomerPayment;
  readonly proofHashes = new Set<string>();

  async loadFundableRun(): Promise<FundableRun> {
    return this.context;
  }
  expired?: Parameters<PaymentReconciliationStore['commitExpiredRun']>[0];
  pastDeadline: readonly ExpirableRun[] = [];

  async findRunsPastPaymentDeadline(): Promise<readonly ExpirableRun[]> {
    return this.pastDeadline;
  }

  async commitExpiredRun(input: Parameters<PaymentReconciliationStore['commitExpiredRun']>[0]): Promise<void> {
    if (input.previousRevision !== this.context.run.revision) throw new Error('revision conflict');
    this.expired = input;
    this.context = { ...this.context, run: input.run };
  }
  async commitFundedRun(input: Parameters<PaymentReconciliationStore['commitFundedRun']>[0]): Promise<void> {
    if (input.previousRevision !== this.context.run.revision) throw new Error('revision conflict');
    if (this.proofHashes.has(input.payment.proofHash)) throw new Error('payment proof replay');
    this.proofHashes.add(input.payment.proofHash);
    this.context = {
      ...this.context,
      run: input.run,
      customerPaymentProofHash: input.payment.proofHash,
      customerPayment: input.payment,
    };
    this.committed = input.payment;
  }
}

function merchantAdapter(): X402MerchantAdapter {
  return {
    async discoverRuntimeCapabilities() {
      return [capability];
    },
    async createOrder() {
      return initialOrder;
    },
    async getOrderStatus() {
      return { ...initialOrder, status: 'PAYMENT_CONFIRMED' };
    },
    async getOrderProof() {
      return {
        orderId: 'order-1',
        transactionHash: txHash,
        logIndex: 4,
        fromAddress: payer,
        toAddress: recipient,
        atomicAmount: '600',
        chainId: 2345,
      };
    },
  };
}

describe('payment reconciler', () => {
  it('moves PAYMENT_REQUIRED to FUNDED only after matching receipt and Transfer log', async () => {
    const store = new MemoryStore();
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store,
      now: () => new Date('2026-08-04T10:01:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return {
            chainId: 2345,
            transactionHash: txHash,
            status: 1,
            logs: [encodeTransferLog(token, payer, recipient, '600', 4)],
          };
        },
      },
    });

    await expect(reconciler.reconcile('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      proof: { transactionHash: txHash },
    });
    expect(store.context.run).toMatchObject({ status: 'FUNDED', revision: 3 });
    expect(store.committed?.proofHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('returns the immutable verified payment when a post-commit job is retried', async () => {
    const store = new MemoryStore();
    let providerCalls = 0;
    const adapter = merchantAdapter();
    const reconciler = new PaymentReconciler({
      merchantAdapter: {
        ...adapter,
        async getOrderStatus(orderId, signal) {
          providerCalls += 1;
          return adapter.getOrderStatus(orderId, signal);
        },
      },
      store,
      now: () => new Date('2026-08-04T10:01:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return {
            chainId: 2345,
            transactionHash: txHash,
            status: 1,
            logs: [encodeTransferLog(token, payer, recipient, '600', 4)],
          };
        },
      },
    });

    const first = await reconciler.reconcile('run-1');
    const replay = await reconciler.reconcile('run-1');
    expect(replay).toEqual(first);
    expect(providerCalls).toBe(1);
    expect(store.context.run).toMatchObject({ status: 'FUNDED', revision: 3 });
  });

  it('refuses a provider-confirmed payment when the on-chain recipient differs', async () => {
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store: new MemoryStore(),
      receiptReader: {
        async getTransactionReceipt() {
          return {
            chainId: 2345,
            transactionHash: txHash,
            status: 1,
            logs: [encodeTransferLog(token, payer, '0x4000000000000000000000000000000000000004', '600', 4)],
          };
        },
      },
    });
    await expect(reconciler.reconcile('run-1')).rejects.toBeInstanceOf(SettlementRejectedError);
  });

  it('treats a not-yet-indexed receipt as retryable, not a deterministic rejection', async () => {
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store: new MemoryStore(),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });
    await expect(reconciler.reconcile('run-1')).rejects.toBeInstanceOf(ReceiptNotYetAvailableError);
    await expect(reconciler.reconcile('run-1')).rejects.not.toBeInstanceOf(SettlementRejectedError);
  });

  it('reports an unpaid order past its own deadline as expired, not as "not ready yet"', async () => {
    // Reporting this as not-ready is what stranded runs: the job kept polling on a dead order,
    // burned its whole retry budget, dead-lettered, and left the run in PAYMENT_REQUIRED forever.
    const reconciler = new PaymentReconciler({
      merchantAdapter: {
        ...merchantAdapter(),
        async getOrderStatus() {
          return { ...initialOrder, status: 'CHECKOUT_VERIFIED' };
        },
      },
      store: new MemoryStore(),
      now: () => new Date('2026-08-04T10:15:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });

    await expect(reconciler.reconcile('run-1')).rejects.toBeInstanceOf(PaymentOrderExpiredError);
  });

  it('still waits on an unpaid order that has time left, so a customer mid-checkout is not cut off', async () => {
    const reconciler = new PaymentReconciler({
      merchantAdapter: {
        ...merchantAdapter(),
        async getOrderStatus() {
          return { ...initialOrder, status: 'CHECKOUT_VERIFIED' };
        },
      },
      store: new MemoryStore(),
      now: () => new Date('2026-08-04T10:14:59.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });

    await expect(reconciler.reconcile('run-1')).rejects.toBeInstanceOf(PaymentNotReadyError);
  });

  it('expires an unpaid run to the terminal EXPIRED state', async () => {
    const store = new MemoryStore();
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store,
      now: () => new Date('2026-08-04T10:16:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });

    await expect(reconciler.expireRun('run-1')).resolves.toBe(true);
    expect(store.context.run.status).toBe('EXPIRED');
    expect(store.expired?.event.actor).toBe('SYSTEM');
  });

  it('refuses to expire a run that has already been funded', async () => {
    // A payment landing between the expiry decision and this call must win; expiring a funded run
    // would strand money that was actually received.
    const store = new MemoryStore();
    const funded = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store,
      now: () => new Date('2026-08-04T10:01:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return {
            chainId: 2345,
            transactionHash: txHash,
            status: 1 as const,
            logs: [encodeTransferLog(token, payer, recipient, '600', 4)],
          };
        },
      },
    });
    await funded.reconcile('run-1');

    await expect(funded.expireRun('run-1')).resolves.toBe(false);
    expect(store.context.run.status).toBe('FUNDED');
  });

  it('sweeps a run abandoned at QUOTED, which never gets a reconciliation job to close it out', async () => {
    const store = new MemoryStore();
    const quotedRun = transitionRun(createDraftRun('run-2', '2026-08-04T10:00:00.000Z'), {
      actor: 'QUOTE_ENGINE',
      expectedRevision: 0,
      idempotencyKey: 'quoted-0002',
      occurredAt: '2026-08-04T10:00:00.000Z',
      to: 'QUOTED',
    }).run;
    store.context = { ...store.context, run: quotedRun };
    store.pastDeadline = [{ run: quotedRun, deadline: '2026-08-04T10:15:00.000Z', reason: 'QUOTE_EXPIRED' }];
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store,
      now: () => new Date('2026-08-04T11:00:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });

    await expect(reconciler.sweepExpiredRuns()).resolves.toEqual(['run-2']);
    expect(store.expired?.run.status).toBe('EXPIRED');
  });

  it('sweeps nothing when no run has passed its deadline', async () => {
    const store = new MemoryStore();
    const reconciler = new PaymentReconciler({
      merchantAdapter: merchantAdapter(),
      store,
      now: () => new Date('2026-08-04T10:05:00.000Z'),
      receiptReader: {
        async getTransactionReceipt() {
          return null;
        },
      },
    });

    await expect(reconciler.sweepExpiredRuns()).resolves.toEqual([]);
    expect(store.expired).toBeUndefined();
  });
});
