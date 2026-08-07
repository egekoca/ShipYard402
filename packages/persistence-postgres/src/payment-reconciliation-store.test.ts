import { QuoteEngine } from '@shipyard402/quote-engine';
import { encodeTransferLog } from '@shipyard402/x402-payments';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresPaymentReconciliationStore } from './payment-reconciliation-store.js';

const token = '0x1000000000000000000000000000000000000001' as const;
const payer = '0x2000000000000000000000000000000000000002' as const;
const recipient = '0x3000000000000000000000000000000000000003' as const;
const transactionHash = `0x${'ab'.repeat(32)}` as const;
const proofHash = `0x${'cd'.repeat(32)}` as const;
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

const quote = new QuoteEngine({
  pricingStatus: 'HYPOTHESIS',
  feeRateBps: 1667, // chosen so total stays 600, matching this file's on-chain fixture amounts
  mandatoryToolBudgetAtomic: '100',
  dynamicToolBudgetAtomic: '100',
  modelInfrastructureReserveAtomic: '100',
  chainStorageReserveAtomic: '100',
  riskSupportReserveAtomic: '100',
  quoteTtlSeconds: 900,
}, () => 'fixed-id').createQuote({
  organizationId: '7d575e3d-a625-4b71-a28b-86dc202d1d7f',
  requesterAddress: payer,
  targetAgentId: 'agent:external',
  targetServiceId: 'service:external',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  x402Endpoint: 'https://target.example/paid',
  openApiUrl: 'https://target.example/openapi.json',
  maximumCustomerBudgetAtomic: '1000',
}, capability, new Date('2026-08-04T10:00:00.000Z'));

const paymentRequired = {
  x402Version: 2,
  resource: { url: 'https://shipyard.example/run' },
  accepts: [{
    scheme: 'exact',
    network: 'eip155:2345',
    amount: '600',
    asset: token,
    payTo: recipient,
    maxTimeoutSeconds: 900,
  }],
} as const;

const order = {
  orderId: 'order-1',
  dappOrderId: 'run-1',
  status: 'PAYMENT_CONFIRMED',
  chainId: 2345,
  tokenAddress: token,
  atomicAmount: '600',
  payerAddress: payer,
  payToAddress: recipient,
  expiresAt: '2026-08-04T10:15:00.000Z',
  paymentRequired,
} as const;

const proof = {
  orderId: 'order-1',
  transactionHash,
  logIndex: 4,
  fromAddress: payer,
  toAddress: recipient,
  atomicAmount: '600',
  chainId: 2345,
} as const;

const receipt = {
  chainId: 2345,
  transactionHash,
  status: 1 as const,
  logs: [encodeTransferLog(token, payer, recipient, '600', 4)],
};

describe('PostgresPaymentReconciliationStore', () => {
  it('loads the immutable verified customer payment for an idempotent worker replay', async () => {
    const store = new PostgresPaymentReconciliationStore(fakePool(fundableRow()));
    await expect(store.loadFundableRun('run-1')).resolves.toMatchObject({
      run: { id: 'run-1', status: 'FUNDED', revision: 3 },
      customerPaymentProofHash: proofHash,
      customerPayment: {
        runId: 'run-1',
        proofHash,
        proof: { transactionHash },
        receipt: { transactionHash, status: 1 },
      },
    });
  });

  it('rejects a stored payload that conflicts with indexed receipt columns', async () => {
    const row = fundableRow();
    const store = new PostgresPaymentReconciliationStore(fakePool({
      ...row,
      receipt_transaction_hash: Buffer.from('ef'.repeat(32), 'hex'),
    }));
    await expect(store.loadFundableRun('run-1')).rejects.toThrow('conflicts with indexed receipt columns');
  });
});

function fakePool(runRow: ReturnType<typeof fundableRow>): Pool {
  return {
    async query(sql: string) {
      if (sql.includes('FROM runs r')) return { rows: [runRow] };
      if (sql.includes('FROM payment_orders')) {
        return { rows: [{ order_snapshot: order, capability_snapshot: capability }] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  } as unknown as Pool;
}

function fundableRow() {
  return {
    run_id: 'run-1',
    status: 'FUNDED',
    result: null,
    revision: '3',
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:01:00.000Z',
    applied_keys: ['quoted-0001', 'payment-order-0001', 'customer-payment-0001'],
    customer_payment_proof_hash: hexBuffer(proofHash),
    quote_id: quote.id,
    request_snapshot: quote.request,
    capability_snapshot: quote.capabilitySnapshot,
    line_items: quote.lineItems,
    pricing_status: quote.pricingStatus,
    total_atomic_amount: quote.totalAtomicAmount,
    refundable_tool_budget_atomic: quote.refundableToolBudgetAtomic,
    quote_created_at: quote.createdAt,
    quote_expires_at: quote.expiresAt,
    quote_commitment: hexBuffer(quote.quoteCommitment),
    order_snapshot: order,
    receipt_order_id: order.orderId,
    receipt_chain_id: '2345',
    receipt_payer: hexBuffer(payer),
    receipt_recipient: hexBuffer(recipient),
    receipt_atomic_amount: '600',
    receipt_transaction_hash: hexBuffer(transactionHash),
    receipt_log_index: 4,
    receipt_proof_hash: hexBuffer(proofHash),
    receipt_provider_payload: {
      providerDigest: null,
      providerOrderStatus: order.status,
      onChainReceiptStatus: receipt.status,
      proof,
      receipt,
    },
    receipt_verified_at: '2026-08-04T10:01:00.000Z',
  };
}

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
