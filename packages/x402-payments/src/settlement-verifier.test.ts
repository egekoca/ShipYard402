import { describe, expect, it } from 'vitest';

import { encodeTransferLog, verifySettlement } from './settlement-verifier.js';

const token = '0x1000000000000000000000000000000000000001' as const;
const payer = '0x2000000000000000000000000000000000000002' as const;
const recipient = '0x3000000000000000000000000000000000000003' as const;
const txHash = `0x${'ab'.repeat(32)}` as const;

const expected = {
  chainId: 2345,
  tokenAddress: token,
  payerAddress: payer,
  recipientAddress: recipient,
  atomicAmount: '5000000',
  orderId: 'order_001',
} as const;

const order = {
  orderId: 'order_001',
  dappOrderId: 'run_001',
  status: 'PAYMENT_CONFIRMED',
  chainId: 2345,
  tokenAddress: token,
  atomicAmount: '5000000',
  payerAddress: payer,
  payToAddress: recipient,
  expiresAt: '2026-08-04T12:00:00.000Z',
  paymentRequired: {
    x402Version: 2,
    resource: { url: 'https://shipyard.example/v1/runs' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:2345',
      amount: '5000000',
      asset: token,
      payTo: recipient,
      maxTimeoutSeconds: 900,
    }],
  },
} as const;

const proof = {
  orderId: 'order_001',
  transactionHash: txHash,
  logIndex: 4,
  fromAddress: payer,
  toAddress: recipient,
  atomicAmount: '5000000',
  chainId: 2345,
} as const;

describe('settlement verifier', () => {
  it('accepts a matching confirmed ERC-20 transfer', () => {
    const result = verifySettlement(
      order,
      proof,
      {
        chainId: 2345,
        transactionHash: txHash,
        status: 1,
        logs: [encodeTransferLog(token, payer, recipient, '5000000', 4)],
      },
      expected,
    );
    expect(result.valid).toBe(true);
    expect(result.failureCodes).toEqual([]);
  });

  it('rejects a wrong recipient and amount', () => {
    const wrongRecipient = '0x4000000000000000000000000000000000000004' as const;
    const result = verifySettlement(
      { ...order, payToAddress: wrongRecipient },
      { ...proof, toAddress: wrongRecipient },
      {
        chainId: 2345,
        transactionHash: txHash,
        status: 1,
        logs: [encodeTransferLog(token, payer, wrongRecipient, '1', 4)],
      },
      expected,
    );
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toEqual(expect.arrayContaining(['RECIPIENT_MISMATCH', 'TRANSFER_LOG_MISMATCH']));
  });

  it('does not trust a provider digest without an on-chain log', () => {
    const result = verifySettlement(
      order,
      { ...proof, providerDigest: `0x${'cd'.repeat(32)}` },
      { chainId: 2345, transactionHash: txHash, status: 1, logs: [] },
      expected,
    );
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain('TRANSFER_LOG_MISSING');
  });
});
