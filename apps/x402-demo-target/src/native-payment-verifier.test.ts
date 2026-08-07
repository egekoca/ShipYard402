import { TransactionNotFoundError, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { ViemNativeTransferReader } from './native-payment-verifier.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const FROM = '0x2000000000000000000000000000000000000002' as const;
const TO = '0x3000000000000000000000000000000000000003' as const;

function fakeClient(overrides: Partial<{
  chainId: number;
  transaction: { from: `0x${string}`; to: `0x${string}` | null; value: bigint };
  receiptStatus: 'success' | 'reverted';
  blockNumber: bigint | null;
  currentBlock: bigint;
  throwNotFound: boolean;
}>): PublicClient {
  const {
    chainId = 48816,
    transaction = { from: FROM, to: TO, value: 1_000_000_000_000n },
    receiptStatus = 'success',
    blockNumber = 100n,
    currentBlock = 103n,
    throwNotFound = false,
  } = overrides;

  return {
    getChainId: async () => chainId,
    getTransaction: async () => {
      if (throwNotFound) throw new TransactionNotFoundError({ hash: HASH });
      return transaction;
    },
    getTransactionReceipt: async () => ({ status: receiptStatus, blockNumber }),
    getBlockNumber: async () => currentBlock,
  } as unknown as PublicClient;
}

describe('ViemNativeTransferReader', () => {
  it('returns a confirmed successful transfer with computed confirmations', async () => {
    const reader = new ViemNativeTransferReader(fakeClient({}), 48816);
    await expect(reader.getConfirmedTransfer(HASH)).resolves.toMatchObject({
      status: 'success',
      from: FROM,
      to: TO,
      valueWei: 1_000_000_000_000n,
      confirmations: 4n,
    });
  });

  it('reports a reverted transaction', async () => {
    const reader = new ViemNativeTransferReader(fakeClient({ receiptStatus: 'reverted' }), 48816);
    await expect(reader.getConfirmedTransfer(HASH)).resolves.toMatchObject({ status: 'reverted' });
  });

  it('returns null when the transaction is not found', async () => {
    const reader = new ViemNativeTransferReader(fakeClient({ throwNotFound: true }), 48816);
    await expect(reader.getConfirmedTransfer(HASH)).resolves.toBeNull();
  });

  it('rejects when the RPC reports an unexpected chain id', async () => {
    const reader = new ViemNativeTransferReader(fakeClient({ chainId: 1 }), 48816);
    await expect(reader.getConfirmedTransfer(HASH)).rejects.toThrow('RPC chain mismatch');
  });

  it('recovers from a transient chain-verification failure instead of caching the rejection forever', async () => {
    let calls = 0;
    const flakyThenHealthy = {
      getChainId: async () => {
        calls += 1;
        if (calls === 1) throw new Error('RPC timeout');
        return 48816;
      },
      getTransaction: async () => ({ from: FROM, to: TO, value: 1_000_000_000_000n }),
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n }),
      getBlockNumber: async () => 103n,
    } as unknown as PublicClient;
    const reader = new ViemNativeTransferReader(flakyThenHealthy, 48816);

    await expect(reader.getConfirmedTransfer(HASH)).rejects.toThrow('RPC timeout');
    await expect(reader.getConfirmedTransfer(HASH)).resolves.toMatchObject({ status: 'success' });
    expect(calls).toBe(2);
  });
});
