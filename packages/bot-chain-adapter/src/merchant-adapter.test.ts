import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import { encodeTransferLog, verifySettlement, type NormalizedTransactionReceipt } from '@shipyard402/x402-payments';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BotChainDirectMerchantAdapter,
  InMemoryBotChainOrderContextStore,
  type BotChainReceiptSource,
} from './merchant-adapter.js';

const token = '0x1000000000000000000000000000000000000001' as const;
const payer = '0x2000000000000000000000000000000000000002' as const;
const receivingAddress = '0x3000000000000000000000000000000000000003' as const;
const txHash = `0x${'ab'.repeat(32)}` as const;

const capability: BotChainRuntimeCapability = {
  environment: 'botChainTestnet',
  merchantId: 'shipyard-botchain',
  mode: 'DIRECT_ERC20',
  chainId: 968,
  tokenAddress: token,
  tokenSymbol: 'USDT',
  tokenDecimals: 6,
  receivingAddress,
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '1000000000',
  discoveredAt: '2026-08-13T00:00:00.000Z',
  source: 'STATIC_CONFIG',
};

class StubReceiptSource implements BotChainReceiptSource {
  receipt: NormalizedTransactionReceipt | null = null;
  async getTransactionReceipt(): Promise<NormalizedTransactionReceipt | null> {
    return this.receipt;
  }
}

function makeAdapter(receiptSource: StubReceiptSource, now: () => Date = () => new Date('2026-08-13T00:00:00.000Z')) {
  return new BotChainDirectMerchantAdapter({
    capability,
    contextStore: new InMemoryBotChainOrderContextStore(),
    receiptSource,
    now,
  });
}

describe('BotChainDirectMerchantAdapter', () => {
  let receiptSource: StubReceiptSource;

  beforeEach(() => {
    receiptSource = new StubReceiptSource();
  });

  it('discovers the single statically configured capability', async () => {
    const adapter = makeAdapter(receiptSource);
    expect(await adapter.discoverRuntimeCapabilities()).toEqual([capability]);
  });

  it('creates an order with no remote call, starting CHECKOUT_VERIFIED', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_1',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    expect(order.status).toBe('CHECKOUT_VERIFIED');
    expect(order.payToAddress).toBe(receivingAddress);
    expect(order.tokenAddress).toBe(token);
    expect(order.atomicAmount).toBe('5000000');
  });

  it('is idempotent for the same dappOrderId', async () => {
    const adapter = makeAdapter(receiptSource);
    const first = await adapter.createOrder({
      dappOrderId: 'run_1',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    const second = await adapter.createOrder({
      dappOrderId: 'run_1',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    expect(second.orderId).toBe(first.orderId);
  });

  it('rejects an order outside the capability bounds', async () => {
    const adapter = makeAdapter(receiptSource);
    await expect(
      adapter.createOrder({
        dappOrderId: 'run_over_budget',
        payerAddress: payer,
        atomicAmount: '99999999999',
        capability,
      }),
    ).rejects.toThrow(/bounds/);
  });

  it('stays CHECKOUT_VERIFIED before any transaction is submitted', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_2',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    const status = await adapter.getOrderStatus(order.orderId);
    expect(status.status).toBe('CHECKOUT_VERIFIED');
    await expect(adapter.getOrderProof(order.orderId)).rejects.toThrow(/No verified payment/);
  });

  it('reports EXPIRED once the order TTL has passed with no confirmed payment', async () => {
    let now = new Date('2026-08-13T00:00:00.000Z');
    const adapter = new BotChainDirectMerchantAdapter({
      capability,
      contextStore: new InMemoryBotChainOrderContextStore(),
      receiptSource,
      orderTtlSeconds: 60,
      now: () => now,
    });
    const order = await adapter.createOrder({
      dappOrderId: 'run_expiring',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    now = new Date('2026-08-13T00:05:00.000Z');
    const status = await adapter.getOrderStatus(order.orderId);
    expect(status.status).toBe('EXPIRED');
  });

  it('stays CHECKOUT_VERIFIED while a submitted transaction has no receipt yet', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_3',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    await adapter.submitPaymentTransaction(order.orderId, txHash);
    receiptSource.receipt = null; // RPC hasn't indexed the transaction yet
    const status = await adapter.getOrderStatus(order.orderId);
    expect(status.status).toBe('CHECKOUT_VERIFIED');
  });

  it('accepts a replacement hash until a transaction has produced an exact payment proof', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_replacement',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    const replacementHash = `0x${'cd'.repeat(32)}` as const;
    await adapter.submitPaymentTransaction(order.orderId, txHash);
    await expect(adapter.submitPaymentTransaction(order.orderId, replacementHash)).resolves.toBeUndefined();
  });

  it('confirms payment once the submitted transaction has a matching Transfer log', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_4',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    await adapter.submitPaymentTransaction(order.orderId, txHash);
    receiptSource.receipt = {
      chainId: 968,
      transactionHash: txHash,
      status: 1,
      logs: [encodeTransferLog(token, payer, receivingAddress, '5000000', 2)],
    };

    const status = await adapter.getOrderStatus(order.orderId);
    expect(status.status).toBe('PAYMENT_CONFIRMED');

    const proof = await adapter.getOrderProof(order.orderId);
    expect(proof).toMatchObject({
      orderId: order.orderId,
      transactionHash: txHash,
      logIndex: 2,
      fromAddress: payer,
      toAddress: receivingAddress,
      atomicAmount: '5000000',
      chainId: 968,
    });
  });

  it('does not confirm a transaction whose Transfer log does not match the order', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_5',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    await adapter.submitPaymentTransaction(order.orderId, txHash);
    receiptSource.receipt = {
      chainId: 968,
      transactionHash: txHash,
      status: 1,
      // wrong amount
      logs: [encodeTransferLog(token, payer, receivingAddress, '1', 2)],
    };

    const status = await adapter.getOrderStatus(order.orderId);
    expect(status.status).toBe('CHECKOUT_VERIFIED');
  });

  it('produces an order/proof pair that passes the real, unmodified verifySettlement', async () => {
    const adapter = makeAdapter(receiptSource);
    const order = await adapter.createOrder({
      dappOrderId: 'run_6',
      payerAddress: payer,
      atomicAmount: '5000000',
      capability,
    });
    await adapter.submitPaymentTransaction(order.orderId, txHash);
    const receipt: NormalizedTransactionReceipt = {
      chainId: 968,
      transactionHash: txHash,
      status: 1,
      logs: [encodeTransferLog(token, payer, receivingAddress, '5000000', 2)],
    };
    receiptSource.receipt = receipt;

    const confirmedOrder = await adapter.getOrderStatus(order.orderId);
    const proof = await adapter.getOrderProof(order.orderId);

    const verification = verifySettlement(confirmedOrder, proof, receipt, {
      chainId: 968,
      tokenAddress: token,
      payerAddress: payer,
      recipientAddress: receivingAddress,
      atomicAmount: '5000000',
      orderId: order.orderId,
    });
    expect(verification.valid).toBe(true);
    expect(verification.failureCodes).toEqual([]);
  });
});
