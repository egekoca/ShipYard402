import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import type { X402PaymentRequired } from 'goatflow-sdk-server';
import { describe, expect, it } from 'vitest';

import {
  GoatFlowMerchantAdapter,
  InMemoryFlowOrderContextStore,
  type GoatFlowClientPort,
} from './merchant-adapter.js';

const capability: FlowRuntimeCapability = {
  environment: 'mainnet',
  merchantId: 'merchant-1',
  mode: 'ERC20_DIRECT',
  chainId: 2345,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  tokenSymbol: 'RUNTIME_TOKEN',
  tokenDecimals: 6,
  receivingAddress: '0x3000000000000000000000000000000000000003',
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '10000000',
  discoveredAt: '2026-08-04T10:00:00.000Z',
  source: 'PORTAL_REVIEW',
};

function client(overrides: Partial<GoatFlowClientPort> = {}): GoatFlowClientPort {
  return {
    async createOrder() { return {
      orderId: 'flow-order-1', flow: 'ERC20_DIRECT', tokenSymbol: 'RUNTIME_TOKEN',
      tokenContract: capability.tokenAddress, payToAddress: capability.receivingAddress,
      fromChainId: 2345, payToChainId: 2345, amountWei: '4700000', expiresAt: 1_786_000_000,
      x402: paymentRequired(capability.receivingAddress),
    }; },
    async getOrderStatus() { return {
      orderId: 'flow-order-1', merchantId: 'merchant-1', dappOrderId: 'run-1', chainId: 2345,
      tokenContract: capability.tokenAddress, tokenSymbol: 'RUNTIME_TOKEN',
      fromAddress: '0x2000000000000000000000000000000000000002', amountWei: '4700000',
      status: 'PAYMENT_CONFIRMED',
    }; },
    async getOrderProof() { return {
      payload: {
        order_id: 'flow-order-1', tx_hash: `0x${'ab'.repeat(32)}`, log_index: 7,
        from_addr: '0x2000000000000000000000000000000000000002',
        to_addr: capability.receivingAddress, amount_wei: '4700000', from_chain_id: 2345,
        status: 'PAYMENT_CONFIRMED',
      },
      signature: `0x${'cd'.repeat(32)}`,
    }; },
    async getMerchant() { return {
      merchantId: 'merchant-1', name: 'Shipyard402', receiveType: 'DIRECT',
      supportedTokens: [{ chainId: 2345, symbol: 'RUNTIME_TOKEN', tokenContract: capability.tokenAddress }],
    }; },
    ...overrides,
  };
}

function adapter(flowClient = client()) {
  return new GoatFlowMerchantAdapter({
    merchantId: 'merchant-1',
    client: flowClient,
    contextStore: new InMemoryFlowOrderContextStore(),
    capabilitySource: { async loadReviewedCapabilities() { return [capability]; } },
  });
}

const createInput = {
  dappOrderId: 'run-1',
  payerAddress: '0x2000000000000000000000000000000000000002',
  atomicAmount: '4700000',
  capability,
} as const;

describe('GOAT Flow merchant adapter', () => {
  it('cross-checks reviewed capabilities against public merchant configuration', async () => {
    await expect(adapter().discoverRuntimeCapabilities()).resolves.toEqual([capability]);
  });

  it('creates and retains an exact DIRECT order context for later reconciliation', async () => {
    const subject = adapter();
    const created = await subject.createOrder(createInput);
    expect(created).toMatchObject({ status: 'CHECKOUT_VERIFIED', payToAddress: capability.receivingAddress });
    await expect(subject.getOrderStatus(created.orderId)).resolves.toMatchObject({ status: 'PAYMENT_CONFIRMED' });
    await expect(subject.getOrderProof(created.orderId)).resolves.toMatchObject({
      transactionHash: `0x${'ab'.repeat(32)}`,
      providerDigest: `0x${'cd'.repeat(32)}`,
    });
  });

  it('rejects a provider order whose recipient differs from the reviewed capability', async () => {
    const wrongRecipientClient = client({
      async createOrder() { return {
        orderId: 'bad-order', flow: 'ERC20_DIRECT', tokenSymbol: 'RUNTIME_TOKEN',
        tokenContract: capability.tokenAddress,
        payToAddress: '0x4000000000000000000000000000000000000004',
        fromChainId: 2345, payToChainId: 2345, amountWei: '4700000', expiresAt: 1_786_000_000,
        x402: paymentRequired('0x4000000000000000000000000000000000000004'),
      }; },
    });
    await expect(adapter(wrongRecipientClient).createOrder(createInput)).rejects.toThrow('recipient');
  });

  it('does not retain a conflicting order after an idempotency rejection', async () => {
    const store = new InMemoryFlowOrderContextStore();
    const subject = new GoatFlowMerchantAdapter({
      merchantId: 'merchant-1',
      client: client(),
      contextStore: store,
      capabilitySource: { async loadReviewedCapabilities() { return [capability]; } },
    });
    const first = await subject.createOrder(createInput);
    const conflicting = {
      order: { ...first, orderId: 'flow-order-conflict' },
      capability,
    };

    await expect(store.put(conflicting)).rejects.toThrow('DApp order ID');
    await expect(store.get('flow-order-conflict')).resolves.toBeNull();
    await expect(store.getByDappOrderId('run-1')).resolves.toMatchObject({
      order: { orderId: 'flow-order-1' },
    });
  });
});

function paymentRequired(recipient: string): X402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://shipyard.example/v1/runs/run-1' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:2345',
      amount: '4700000',
      asset: capability.tokenAddress,
      payTo: recipient,
      maxTimeoutSeconds: 900,
    }],
    order_id: 'flow-order-1',
    flow: 'ERC20_DIRECT',
    token_symbol: 'RUNTIME_TOKEN',
  };
}
